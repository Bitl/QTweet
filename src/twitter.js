"use strict";
import Twitter from "twitter-lite";

import * as pw from "../pw.json";

import { isSet } from "./flags";
import { getUserIds, getUserSubs, updateUser } from "./subs";
import Backup from "./backup";
import log from "./log";

import { embed as postEmbed, message as postMessage } from "./post";
import Stream from "./twitterStream";
import QChannel from "./QChannel.js";
import unfurl from "unfurl.js";

// Stream object, holds the twitter feed we get posts from, initialized at the first
let stream = null;

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

const streamStart = () => {
  log("Stream successfully started");
  reconnectionDelay.reset();
};

// Validation function for tweets
export const isValid = tweet =>
  !(
    !tweet ||
    !tweet.user ||
    (tweet.is_quote_status &&
      (!tweet.quoted_status || !tweet.quoted_status.user))
  );

const formatTweetText = async (text, entities, isTextTweet) => {
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
  let bestPreview = null;
  if (urls) {
    for (let i = urls.length - 1; i >= 0; i--) {
      const { expanded_url, indices } = urls[i];
      if (!(expanded_url && indices && indices.length === 2)) return;
      if (isTextTweet && !bestPreview) {
        try {
          const { open_graph, twitter_card } = await unfurl(expanded_url);
          bestPreview =
            (twitter_card &&
              twitter_card.images &&
              twitter_card.images[0] &&
              twitter_card.images[0].url) ||
            (open_graph &&
              open_graph.images &&
              open_graph.images[0] &&
              open_graph.images[0].url) ||
            bestPreview;
          if (bestPreview && bestPreview.startsWith("//"))
            bestPreview = "https:" + bestPreview;
          else if (bestPreview && !bestPreview.startsWith("http")) {
            bestPreview = null;
          }
        } catch (e) {
          bestPreview = null;
        }
      }
      const [start, end] = indices;
      changes.push({ start, end, newText: expanded_url });
    }
  }
  if (bestPreview) {
    metadata.preview = bestPreview;
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
export const formatTweet = async (tweet, isQuoted) => {
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
      name: `${isQuoted ? "[QUOTED] " : ""}${user.name} (@${user.screen_name})`,
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
  const isTextTweet = !hasMedia(tweet);
  const { text: formattedText, metadata } = await formatTweetText(
    txt,
    entities,
    isTextTweet
  );
  txt = formattedText;
  if (isTextTweet) {
    // Text tweet
    if (metadata.preview) {
      embed.image = { url: metadata.preview };
    }
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
  const subs = await getFilteredSubs(tweet);
  if (subs.length === 0) return;
  const { embed, metadata } = await formatTweet(tweet);
  subs.forEach(({ flags, qChannel }) => {
    if (metadata.ping && flags.ping) {
      log("Pinging @everyone", qChannel);
      postMessage(qChannel, "@everyone");
    }
    postEmbed(qChannel, embed);
  });
  if (tweet.is_quote_status) {
    const { embed: quotedEmbed } = await formatTweet(tweet.quoted_status, true);
    subs.forEach(({ flags, qChannel }) => {
      if (!flags.noquote) postEmbed(qChannel, quotedEmbed);
    });
  }
  updateUser(tweet.user);
};

const streamEnd = () => {
  // The backup exponential algorithm will take care of reconnecting
  stream.disconnected();
  log(
    `: We got disconnected from twitter. Reconnecting in ${reconnectionDelay.value()}ms...`
  );
  setTimeout(createStream, reconnectionDelay.value());
  reconnectionDelay.increment();
};

const streamError = ({ url, status, statusText }) => {
  // We simply can't get a stream, don't retry
  stream.disconnected();
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
  stream.disconnected();
};

export const userLookup = params => {
  return tClient.post("users/lookup", params);
};

export const showTweet = (id, params) => {
  return tClient.get(`statuses/show/${id}`, params);
};

// Max timeline requests per 15min window
const maxRequests = 1000;
// Total
let requests = 0;
let lastResetDate = new Date.now();
// PLACEHOLDER
let nextResetDate = "LAST RESET + 15MIN";

const minDelay = 1000 * 60 * 15;
export const userTimeline = params => {
  requests++;
  return tClient.get("statuses/user_timeline", params);
};

// twitterId: The user's unique ID
// lastFetchDate: The time we last got the user's data. Also the time !!start was run if we never got any tweets.
//      Users are queued in order of last fetch date, so the ones who never get posted are always checked first.
//      We call this queue privilege and you lose it when you tweet anything.
// recommendedFetchDate: The date at which we think we should try again. Also the time !!start was run if the user was never checked.
// lastTweetId: Last time we got a tweet, we recorded its last ID.
const checkUser = async ({
  twitterId,
  lastFetchDate,
  recommendedFetchDate,
  lastTweetId
}) => {
  if (recommendedFetchDate > Date.now()) return; // If it's not your time, it's not your time, do nothing
  if (requests > maxRequests) {
    // Set the next check to be @ next reset, don't update any other data to keep queue privileges
    return;
  }
  // We should now get their latest tweets.
  const params = {
    user_id: twitterId,
    tweet_mode: "extended"
  };
  if (lastTweetId) {
    params.since_id = lastTweetId;
  } else {
    params.count = 1;
  }
  // This costs us one call
  const tweets = await userTimeline(params);
  if (tweets.length > 0) {
    // There are tweets to post! Post them and update user data with lower delay
    // No minimum delay here, but they lose queue privileges
    return;
  }
  // No tweets, bad user made us waste a request >:c
  // Increase the recommended fetch date
  let nextDelay = (Date.now() - lastFetchDate) * 2;
  if (nextDelay < minDelay) {
    // Apply minimum delay because they were bad boys
    nextDelay = minDelay;
  }
  // Update recommended fetch date here, date = Date.now() + nextDelay
};

export const init = async () => {
  // This function fetches all twitter users & their metadata
  // Data should be ordered by last fetch ASCENDING so we start with the oldest ones
  const users = PLACEHOLDER_get_data();
  // Check each user
  for (let i = 0; i < users.length; i++) {
    checkUser(users[i]);
  }
};
