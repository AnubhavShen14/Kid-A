'use strict';

const redis = require('./redis.js');

const MINUTE = 1000 * 60;
const DAY = 24 * 60 * MINUTE;

let leftpad = val => (val < 10 ? `0${val}`: `${val}`);

class ChatLogger {
	constructor() {
		this.logs = redis.useDatabase('logs');
		this.seen = redis.useDatabase('seen');

		this.rooms = [];
		this.queue = [];
		this.queuedOperations = [];
		this.syncing = false;

		this.logs.keys('*').then(keys => {
			for (let i = 0; i < keys.length; i++) {
				let roomid = keys[i].split(':')[0];
				if (!this.rooms.includes(roomid)) this.rooms.push(roomid);
			}
		});

		setInterval(async () => {
			this.syncing = true;
			let oldqueue = this.queue;
			this.queue = {};

			if (Object.keys(oldqueue).length) {
				await this.logs.multi();
				for (let key in oldqueue) {
					oldqueue[key].unshift(key);
					this.logs.hmset.apply(this.logs, oldqueue[key]);
				}
				await this.logs.exec();
			}

			this.queuedOperations.forEach(val => val());

			this.syncing = false;
		}, 5 * MINUTE);

		setInterval(this.pruneAll, DAY);

		this.pruneAll();
	}

	waitForSync() {
		return new Promise(resolve => {
			if (!this.syncing) resolve();

			this.queuedOperations.push(resolve);
		});
	}

	async log(timestamp, room, userid, message) {
		if (Config.disableLogging) return;

		timestamp = parseInt(timestamp);
		if (isNaN(timestamp) || !userid || !room) return;

		timestamp = timestamp * 1000;
		let date = new Date(timestamp);

		if (!(this.rooms.includes(room))) this.rooms.push(room);

		let key = `${room}:${userid}`;

		if (!(key in this.queue)) {
			this.queue[key] = [];
		}

		this.queue[key].push(`${leftpad(date.getUTCDate())}:${leftpad(date.getUTCMonth() + 1)}:${leftpad(date.getUTCHours())}:${leftpad(date.getMinutes())}:${leftpad(date.getSeconds())}`);
		this.queue[key].push(message);

		if (!Handler.privateRooms.has(room)) this.seen.set(userid, timestamp);
	}

	async getLineCount(room, userid) {
		await this.waitForSync();

		let linecount = await this.logs.hkeys(`${room}:${userid}`);
		let output = {};

		// used for pruning
		let today = new Date();
		let toPrune = [];

		for (let key of linecount) {
			let [day, month] = key.split(':');

			if (parseInt(month) < today.getUTCMonth() + 1 && (parseInt(day) < today.getUTCDate() || parseInt(month) < today.getUTCMonth())) {
				toPrune.push(key);
				continue;
			}

			let outputkey = `${day}/${month}`;
			if (outputkey in output) {
				output[outputkey] ++;
			} else {
				output[outputkey] = 1;
			}
		}

		if (toPrune.length) {
			toPrune.unshift(`${room}:${userid}`);
			this.logs.hdel.apply(this.logs, toPrune);
		}

		return output;
	}

	async getUserActivity(room, options) {
		await this.waitForSync();

		let users = await this.logs.keys(`${room}:*`);

		let output = {};

		// used for pruning
		let today = new Date();

		for (let i = 0; i < users.length; i++) {
			let user = users[i].split(':')[1];

			let keys = await this.logs.hkeys(users[i]);

			let toPrune = keys.filter(key => parseInt(key.split(':')[1]) < today.getUTCMonth() + 1 && (parseInt(key.split(':')[0]) < today.getUTCDate() || parseInt(key.split(':')[1]) < today.getUTCMonth()));
			keys = keys.filter(key => !toPrune.includes(key));

			if (options.day) {
				keys = keys.filter(key => key.split(':')[0] === leftpad(today.getUTCDate()) && key.split(':')[1] === leftpad(today.getUTCMonth() + 1));
			}

			if (options.time) {
				let hour = leftpad(options.time);

				keys = keys.filter(key => key.split(':')[2] === hour);
			}

			output[user] = keys.length;

			if (toPrune.length) {
				toPrune.unshift(users[i]);
				this.logs.hdel.apply(this.logs, toPrune);
			}
		}

		return Object.entries(output).sort((a, b) => (a[1] > b[1] ? -1 : 1));
	}

	async getRoomActivity(room) {
		await this.waitForSync();

		let users = await this.logs.keys(`${room}:*`);

		let output = {};

		// used for pruning
		let today = new Date();

		for (let i = 0; i < users.length; i++) {
			let userlogs = await this.logs.hkeys(users[i]);

			let toPrune = [];

			for (let time of userlogs) {
				let [day, month, hour] = time.split(':');

				if (parseInt(month) < today.getUTCMonth() + 1 && (parseInt(day) < today.getUTCDate() || parseInt(month) < today.getUTCMonth())) {
					toPrune.push(time);
					continue;
				}

				if (hour in output) {
					output[hour] ++;
				} else {
					output[hour] = 1;
				}
			}

			if (toPrune.length) {
				toPrune.unshift(users[i]);
				this.logs.hdel.apply(this.logs, toPrune);
			}
		}

		return Object.entries(output).sort((a, b) => (parseInt(a[0]) > parseInt(b[0]) ? 1 : -1));
	}

	async getUniqueUsers(room) {
		await this.waitForSync();

		return (await this.logs.keys(`${room}*`)).length;
	}

	async getLastSeen(userid) {
		await this.waitForSync();

		return (await this.seen.get(userid));
	}

	async pruneAll() {
		let keys = await this.logs.keys('*');

		for (let user of keys) {
			let linecount = await this.logs.hkeys(user);

			let today = new Date();
			let toPrune = [];

			for (let key of linecount) {
				let [day, month] = key.split(':');

				if (parseInt(month) < today.getUTCMonth() + 1 && (parseInt(day) < today.getUTCDate() || parseInt(month) < today.getUTCMonth())) {
					toPrune.push(key);
				}
			}

			if (toPrune.length) {
				toPrune.unshift(user);
				this.logs.hdel.apply(this.logs, toPrune);
			}
		}
	}
}

module.exports = new ChatLogger();

