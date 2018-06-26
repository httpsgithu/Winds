import RSS from '../models/rss';
import Podcast from '../models/podcast';
import Follow from '../models/follow';

import Pin from '../models/pin';
import Article from '../models/article';

import logger from '../utils/logger';

export async function mergeFeeds(masterId, copyId) {
	let master = await RSS.findById(masterId);
	let copy = await RSS.findById(copyId);

	logger.info(`Removing copy ${copy.feedUrl} and merging it with ${master.feedUrl}`);

	// get the follow relationships
	let follows = await Follow.find({ rss: copy });
	// unfollow all of them
	for (let f of follows) {
		await f.removeFromStream();
	}

	// refollow all of them
	let followInstructions = [];
	for (let f of follows) {
		followInstructions.push({
			type: 'rss',
			userId: f.user._id,
			publicationId: master._id,
		});
	}

	await Follow.getOrCreateMany(followInstructions);
	logger.info(
		`Removed ${follows.length} follow from stream and added them for the new feed`,
	);

	// update the follows
	// TODO is there a better way to handle unique constrains with MongoDB
	let existingFollows = await Follow.find({ rss: master });
	let existingFollowIds = existingFollows.map(f => f._id);
	let result = await Follow.update(
		{ $and: [{ rss: copy }, { id: { $nin: existingFollowIds } }] },
		{ rss: master },
		{ multi: true },
	);

	logger.info(
		`Updated the follow records, found ${existingFollows.length} existing follows, ${
			result.nModified
		} changed`,
	);

	// move the pins where possible
	const articles = await Article.find({ rss: copy._id });
	const articleIds = articles.map(a => a._id);

	logger.info(`Updating pin references for ${articles.length} articles`);

	let pins = await Pin.find({ article: { $in: articleIds } });

	for (let pin of pins) {
		let newArticle = await Article.findOne({ rss: master, url: pin.article.url });
		if (newArticle) {
			await Pin.create({
				user: pin.user,
				createdAt: pin.createdAt,
				article: newArticle,
			});
		}

		// always remove the old to prevent broken state
		await pin.remove();
	}

	logger.info(`Updated all pins, removing old data now`);

	// Remove the old articles
	await Article.remove({ rss: copy._id });

	// Remove the old feed
	const feedUrl = copy.feedUrl;
	await copy.remove();

	// TODO: merge the feed url information
	let feedUrls = [master.feedUrl].concat(
		master.feedUrls,
		[copy.feedUrl],
		copy.feedUrls,
	);

	let uniqueUrls = {};
	for (let url of feedUrls) {
		uniqueUrls[url] = 1;
	}

	let newFeedUrls = Object.keys(uniqueUrls);
	logger.info(`FeedUrls is now ${newFeedUrls}`);

	master.feedUrls = newFeedUrls;
	await master.save();

	logger.info(
		`Completed the merge. ${copy.feedUrl} is now merged with ${master.feedUrl}`,
	);

	return master;
}
