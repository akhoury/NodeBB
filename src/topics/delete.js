'use strict';

var async = require('async');
var db = require('../database');

var user = require('../user');
var posts = require('../posts');
var plugins = require('../plugins');
var batch = require('../batch');


module.exports = function (Topics) {
	Topics.delete = async function (tid, uid) {
		await Promise.all([
			Topics.setTopicFields(tid, {
				deleted: 1,
				deleterUid: uid,
				deletedTimestamp: Date.now(),
			}),
			db.sortedSetsRemove([
				'topics:recent',
				'topics:posts',
				'topics:views',
				'topics:votes',
			], tid),
			removeTopicPidsFromCid(tid),
		]);
	};

	async function removeTopicPidsFromCid(tid) {
		const [cid, pids] = await Promise.all([
			Topics.getTopicField(tid, 'cid'),
			Topics.getPids(tid),
		]);
		await db.sortedSetRemove('cid:' + cid + ':pids', pids);
	}

	async function addTopicPidsToCid(tid) {
		const [cid, pids] = await Promise.all([
			Topics.getTopicField(tid, 'cid'),
			Topics.getPids(tid),
		]);
		let postData = await posts.getPostsFields(pids, ['pid', 'timestamp', 'deleted']);
		postData = postData.filter(post => post && !post.deleted);
		var pidsToAdd = [];
		var scores = [];
		postData.forEach(function (post) {
			pidsToAdd.push(post.pid);
			scores.push(post.timestamp);
		});
		await db.sortedSetAdd('cid:' + cid + ':pids', scores, pidsToAdd);
	}

	Topics.restore = async function (tid) {
		const topicData = await Topics.getTopicData(tid);
		await Promise.all([
			Topics.setTopicField(tid, 'deleted', 0),
			Topics.deleteTopicFields(tid, ['deleterUid', 'deletedTimestamp']),
			Topics.updateRecent(tid, topicData.lastposttime),
			db.sortedSetAddBulk([
				['topics:posts', topicData.postcount, tid],
				['topics:views', topicData.viewcount, tid],
				['topics:votes', parseInt(topicData.votes, 10) || 0, tid],
			]),
			addTopicPidsToCid(tid),
		]);
	};

	Topics.purgePostsAndTopic = async function (tid, uid) {
		const mainPid = await Topics.getTopicField(tid, 'mainPid');
		await batch.processSortedSet('tid:' + tid + ':posts', function (pids, next) {
			async.eachSeries(pids, function (pid, next) {
				posts.purge(pid, uid, next);
			}, next);
		}, { alwaysStartAt: 0 });
		await posts.purge(mainPid, uid);
		await Topics.purge(tid, uid);
	};

	Topics.purge = async function (tid, uid) {
		const [deletedTopic, tags] = await Promise.all([
			Topics.getTopicData(tid),
			Topics.getTopicTags(tid),
		]);
		if (!deletedTopic) {
			return;
		}
		deletedTopic.tags = tags;
		await deleteFromFollowersIgnorers(tid);

		await Promise.all([
			db.deleteAll([
				'tid:' + tid + ':followers',
				'tid:' + tid + ':ignorers',
				'tid:' + tid + ':posts',
				'tid:' + tid + ':posts:votes',
				'tid:' + tid + ':bookmarks',
				'tid:' + tid + ':posters',
			]),
			db.sortedSetsRemove([
				'topics:tid',
				'topics:recent',
				'topics:posts',
				'topics:views',
				'topics:votes',
			], tid),
			deleteTopicFromCategoryAndUser(tid),
			Topics.deleteTopicTags(tid),
			reduceCounters(tid),
		]);
		plugins.fireHook('action:topic.purge', { topic: deletedTopic, uid: uid });
		await db.delete('topic:' + tid);
	};

	async function deleteFromFollowersIgnorers(tid) {
		const [followers, ignorers] = await Promise.all([
			db.getSetMembers('tid:' + tid + ':followers'),
			db.getSetMembers('tid:' + tid + ':ignorers'),
		]);
		const followerKeys = followers.map(uid => 'uid:' + uid + ':followed_tids');
		const ignorerKeys = ignorers.map(uid => 'uid:' + uid + 'ignored_tids');
		await db.sortedSetsRemove(followerKeys.concat(ignorerKeys), tid);
	}

	async function deleteTopicFromCategoryAndUser(tid) {
		const topicData = await Topics.getTopicFields(tid, ['cid', 'uid']);
		await Promise.all([
			db.sortedSetsRemove([
				'cid:' + topicData.cid + ':tids',
				'cid:' + topicData.cid + ':tids:pinned',
				'cid:' + topicData.cid + ':tids:posts',
				'cid:' + topicData.cid + ':tids:lastposttime',
				'cid:' + topicData.cid + ':tids:votes',
				'cid:' + topicData.cid + ':recent_tids',
				'cid:' + topicData.cid + ':uid:' + topicData.uid + ':tids',
				'uid:' + topicData.uid + ':topics',
			], tid),
			user.decrementUserFieldBy(topicData.uid, 'topiccount', 1),
		]);
	}

	async function reduceCounters(tid) {
		var incr = -1;
		await db.incrObjectFieldBy('global', 'topicCount', incr);
		const topicData = await Topics.getTopicFields(tid, ['cid', 'postcount']);
		var postCountChange = incr * topicData.postcount;
		await Promise.all([
			db.incrObjectFieldBy('global', 'postCount', postCountChange),
			db.incrObjectFieldBy('category:' + topicData.cid, 'post_count', postCountChange),
			db.incrObjectFieldBy('category:' + topicData.cid, 'topic_count', incr),
		]);
	}
};
