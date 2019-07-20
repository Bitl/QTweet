import Twitter from "twitter-lite";

import * as pw from "../pw.json";

import { isSet } from "./flags";
import { getUserIds, getUserSubs, updateUser } from "./subs";
import Backup from "./backup";
import log from "./log";

import { embed as postEmbed, message as postMessage } from "./post";
import Stream from "./twitterStream";
import QChannel from "./QChannel.js";

// Stream object, holds the twitter feed we get posts from, initialized at the first
let stream = null;

// Timeout detecting when there haven't been new tweets in the past min
let lastTweetTimeout = null;
const lastTweetDelay = 1000 * 60 * 1;

const colors = Object.freeze({
  text: 0x69b2d6,
  video: 0x67d67d,
  image: 0xd667cf,
  images: 0x53a38d
});

var tClient = new Twitter({
  consumer_key: pw.tId,
  consumer_secret: pw.tSecret,
  access_token_key: pw.tToken,
  access_token_secret: pw.tTokenS
});

const reconnectionDelay = new Backup({
  mode: "exponential",
  startValue: 2000,
  maxValue: 16000
});

const resetTimeout = () => {
  if (lastTweetTimeout) {
    clearTimeout(lastTweetTimeout);
    lastTweetTimeout = null;
  }
};

// Checks if a tweet has any media attached. If false, it's a text tweet
const hasMedia = ({ extended_entities, extended_tweet, retweeted_status }) =>
  (extended_entities &&
    extended_entities.media &&
    extended_entities.media.length > 0) ||
  (extended_tweet &&
    extended_tweet.extended_entities &&
    extended_tweet.extended_entities.media &&
    extended_tweet.extended_entities.media.length > 0) ||
  (retweeted_status &&
    retweeted_status.extended_entities &&
    retweeted_status.extended_entities.media &&
    retweeted_status.extended_entities.media.length > 0);

const startTimeout = () => {
  resetTimeout();
  lastTweetTimeout = setTimeout(() => {
    lastTweetTimeout = null;
    log("⚠️ TIMEOUT: No tweets in a while, re-creating stream");
    createStream();
  }, lastTweetDelay);
};

const streamStart = () => {
  log("Stream successfully started");
  reconnectionDelay.reset();
  startTimeout();
};

// Validation function for tweets
export const isValid = tweet =>
  !(
    !tweet ||
    !tweet.user ||
    (tweet.is_quote_status &&
      (!tweet.quoted_status || !tweet.quoted_status.user))
  );

const formatTweetText = (text, entities) => {
  if (!entities) return text;
  const { user_mentions, urls, hashtags } = entities;
  const changes = [];
  let metadata = {};
  let offset = 0;
  // Remove all the @s at the start of the tweet to make it shorter
  let inReplies = true;
  let replyIndex = 0;
  if (user_mentions) {
    user_mentions
      .filter(
        ({ screen_name, indices }) =>
          screen_name && indices && indices.length === 2
      )
      .forEach(({ screen_name, name, indices }) => {
        const [start, end] = indices;
        if (inReplies && start === replyIndex) {
          changes.push({ start, end: end + 1, newText: "" });
          replyIndex = end + 1;
        } else {
          inReplies = false;
          changes.push({
            start,
            end,
            newText: `[@${
              name ? name : screen_name
            }](https://twitter.com/${screen_name})`
          });
        }
      });
  }

  if (urls) {
    urls
      .filter(
        ({ expanded_url, indices }) =>
          expanded_url && indices && indices.length === 2
      )
      .forEach(({ expanded_url, indices }) => {
        const [start, end] = indices;
        changes.push({ start, end, newText: expanded_url });
      });
  }

  if (hashtags) {
    hashtags
      .filter(({ text, indices }) => text && indices && indices.length === 2)
      .forEach(({ text: hashtagTxt, indices }) => {
        const [start, end] = indices;
        changes.push({
          start,
          end,
          newText: `[#${hashtagTxt}](https://twitter.com/hashtag/${hashtagTxt}?src=hash)`
        });
        if (hashtagTxt.toLowerCase() === "qtweet") {
          metadata.ping = true;
        }
      });
  }

  let codePoints = [...text.normalize("NFC")];
  changes
    .sort((a, b) => a.start - b.start)
    .forEach(({ start, end, newText }) => {
      const nt = [...newText.normalize("NFC")];
      codePoints = codePoints
        .slice(0, start + offset)
        .concat(nt)
        .concat(codePoints.slice(end + offset));
      offset += nt.length - (end - start);
    });
  let fixedText = codePoints
    .join("")
    .replace(/&amp;/g, "&")
    .replace(/&gt;/g, ">")
    .replace(/&lt;/g, "<");
  const linkIdx = fixedText.indexOf("https://t.co/");
  if (linkIdx > -1) {
    fixedText = fixedText.substring(0, linkIdx);
  }
  return {
    text: fixedText,
    metadata
  };
};

// Takes a tweet and formats it for posting.
export const formatTweet = tweet => {
  let {
    id_str,
    user,
    full_text,
    text,
    entities,
    extended_entities,
    extended_tweet,
    retweeted_status
  } = tweet;
  let txt = full_text || text;
  // Extended_tweet is an API twitter uses for tweets over 140 characters.
  if (extended_tweet) {
    ({ extended_entities, entities } = extended_tweet);
    txt = extended_tweet.full_text || extended_tweet.text;
  }
  let targetScreenName = user.screen_name;
  if (retweeted_status) {
    // Copy over media from retweets
    extended_entities = extended_entities || retweeted_status.extended_entities;
    // Use the id_str if there's one
    id_str = retweeted_status.id_str || id_str;
    targetScreenName = retweeted_status.user.screen_name || targetScreenName;
  }
  let embed = {
    author: {
      name: `${user.name} (@${user.screen_name})`,
      url: `https://twitter.com/${targetScreenName}/status/${id_str}`
    },
    thumbnail: {
      url: user.profile_image_url_https
    },
    color: user.profile_link_color
      ? parseInt(user.profile_link_color, 16)
      : null
  };
  // For any additional files
  let files = null;
  const { text: formattedText, metadata } = formatTweetText(txt, entities);
  txt = formattedText;
  if (!hasMedia(tweet)) {
    // Text tweet
    embed.color = embed.color || colors["text"];
  } else if (
    extended_entities.media[0].type === "animated_gif" ||
    extended_entities.media[0].type === "video"
  ) {
    // Gif/video.
    const vidinfo = extended_entities.media[0].video_info;
    let vidurl = null;
    let bitrate = null;
    for (let vid of vidinfo.variants) {
      // Find the best video
      if (vid.content_type === "video/mp4" && vid.bitrate < 1000000) {
        const paramIdx = vid.url.lastIndexOf("?");
        const hasParam = paramIdx !== -1 && paramIdx > vid.url.lastIndexOf("/");
        vidurl = hasParam ? vid.url.substring(0, paramIdx) : vid.url;
        bitrate = vid.bitrate;
      }
    }
    if (vidurl !== null) {
      if (vidinfo.duration_millis < 20000 || bitrate === 0) files = [vidurl];
      else {
        embed.image = { url: extended_entities.media[0].media_url_https };
        txt = `${txt}\n[Link to video](${vidurl})`;
      }
    } else {
      log("Found video tweet with no valid url");
      log(vidinfo);
    }
    embed.color = embed.color || colors["video"];
  } else {
    // Image(s)
    files = extended_entities.media.map(media => media.media_url_https);
    if (files.length === 1) {
      embed.image = { url: files[0] };
      files = null;
    }
    embed.color = embed.color || colors["image"];
  }
  embed.description = txt;
  return { embed: { embed, files }, metadata };
};

// Takes a tweet and determines whether or not it should be posted with these flags
const flagsFilter = (flags, tweet) => {
  if (isSet(flags, "notext") && !hasMedia(tweet)) {
    return false;
  }
  if (!isSet(flags, "retweet") && tweet.retweeted_status) {
    return false;
  }
  if (isSet(flags, "noquote") && tweet.is_quote_status) return false;
  return true;
};

export const getFilteredSubs = async tweet => {
  // Ignore invalid tweets
  if (!isValid(tweet)) return [];
  // Ignore tweets from people we don't follow, and replies unless they're replies to oneself (threads)
  const subs = await getUserSubs(tweet.user.id_str);
  if (
    !subs ||
    subs.length === 0 ||
    (tweet.in_reply_to_user_id && tweet.in_reply_to_user_id !== tweet.user.id)
  )
    return [];

  const targetSubs = [];
  for (let i = 0; i < subs.length; i++) {
    const { flags, channelId, isDM } = subs[i];
    if (flagsFilter(flags, tweet)) {
      const qChannel = QChannel.unserialize({ channelId, isDM });
      targetSubs.push({ flags, qChannel });
    }
  }
  return targetSubs;
};

const streamData = async tweet => {
  // Reset the last tweet timeout
  startTimeout();
  const subs = await getFilteredSubs(tweet);
  if (subs.length === 0) return;
  const { embed, metadata } = formatTweet(tweet);
  subs.forEach(({ flags, qChannel }) => {
    if (metadata.ping && flags.ping) {
      log("Pinging @everyone", qChannel);
      postMessage(qChannel, "@everyone");
    }
    postEmbed(qChannel, embed);
  });
  if (tweet.is_quote_status) {
    const { embed: quotedEmbed } = formatTweet(tweet.quoted_status);
    subs.forEach(({ flags, qChannel }) => {
      if (!flags.noquote) postEmbed(qChannel, quotedEmbed);
    });
  }
  updateUser(tweet.user);
};

const streamEnd = () => {
  // The backup exponential algorithm will take care of reconnecting
  stream.disconnected();
  resetTimeout();
  log(
    `: We got disconnected from twitter. Reconnecting in ${reconnectionDelay.value()}ms...`
  );
  setTimeout(createStream, reconnectionDelay.value());
  reconnectionDelay.increment();
};

const streamError = ({ url, status, statusText }) => {
  // We simply can't get a stream, don't retry
  stream.disconnected();
  resetTimeout();
  let delay = 0;
  if (status === 420) {
    delay = 30000;
  } else {
    delay = reconnectionDelay.value();
    reconnectionDelay.increment();
  }
  log(
    `Twitter Error (${status}: ${statusText}) at ${url}. Reconnecting in ${delay}ms`
  );
  setTimeout(createStream, delay);
};

export const getError = response => {
  if (!response || !response.errors || response.errors.length < 1)
    return { code: null, msg: null };
  return response.errors[0];
};

// Register the stream with twitter, unregistering the previous stream if there was one
// Uses the users variable
export const createStream = async () => {
  if (!stream) {
    stream = new Stream(
      tClient,
      streamStart,
      streamData,
      streamError,
      streamEnd
    );
  }
  // Get all the user IDs
  const userIds = await getUserIds();
  // If there are none, we can just leave stream at null
  if (!userIds || userIds.length < 1) return;
  stream.create(userIds.map(({ twitterId }) => twitterId));
};

export const destroyStream = () => {
  resetTimeout();
  stream.disconnected();
};

export const userLookup = params => {
  return tClient.post("users/lookup", params);
};

export const userTimeline = params => {
  return tClient.get("statuses/user_timeline", params);
};

export const showTweet = (id, params) => {
  return tClient.get(`statuses/show/${id}`, params);
};
