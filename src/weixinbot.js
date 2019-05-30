/* eslint-disable quote-props,no-constant-condition,
  prefer-template,consistent-return,new-cap,no-param-reassign */
import fs from 'fs';
import url from 'url';
import path from 'path';
import http from 'http';
import https from 'https';
import axios from 'axios';
import Debug from 'debug';
import touch from 'touch';
import tough from 'tough-cookie';
import Datastore from 'nedb';
import Promise from 'bluebird';
import EventEmitter from 'events';
import nodemailer from 'nodemailer';
import qrcode from 'qrcode-terminal';
import FileCookieStore from 'tough-cookie-filestore';
import axiosCookieJarSupport from 'node-axios-cookiejar';

import { getUrls, CODES, SP_ACCOUNTS, PUSH_HOST_LIST } from './conf';

Promise.promisifyAll(Datastore.prototype);
const debug = Debug('weixinbot');

let URLS = getUrls({});
const logo = fs.readFileSync(path.join(__dirname, '..', 'logo.txt'), 'utf8');

// try persistent cookie
const cookiePath = path.join(process.cwd(), '.cookie.json');
touch.sync(cookiePath);
const jar = new tough.CookieJar(new FileCookieStore(cookiePath));

const req = axios.create({
  timeout: 35e3,
  headers: {
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
    'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_11_2) ' +
      'AppleWebKit/537.36 (KHTML, like Gecko) Chrome/50.0.2652.0 Safari/537.36',
    'Referer': 'https://wx2.qq.com/',
  },
  jar,
  withCredentials: true,
  xsrfCookieName: null,
  xsrfHeaderName: null,
  httpAgent: new http.Agent({ keepAlive: true }),
  httpsAgent: new https.Agent({ keepAlive: true }),
});

axiosCookieJarSupport(req);

const secretPath = path.join(process.cwd(), '.secret.json');
const makeDeviceID = () => 'e' + Math.random().toFixed(15).toString().substring(2, 17);

class WeixinBot extends EventEmitter {
  constructor(options = {}) {
    super();

    // transporter for send qrcode image url
    // 请不要依赖这个默认提供的邮件账户！。
    this.transporter = nodemailer.createTransport(options.mailOpts || {
      service: 'QQex',
      auth: {
        user: 'weixinbot@javascript.work',
        pass: 'V0an1KqPdz4ZKNuP',
      },
    });

    // email address for get qrcode image url
    this.receiver = options.receiver || '';

    Object.assign(this, CODES);

    debug(logo);
  }

  async run() {
    if (fs.existsSync(secretPath)) {
      this.initConfig();
      const secret = JSON.parse(fs.readFileSync(secretPath, 'utf8'));
      Object.assign(this, secret);
      this.runLoop();
    } else {
      this.init();
    }
  }

  initConfig() {
    this.baseHost = '';
    this.pushHost = '';
    this.uuid = '';
    this.redirectUri = '';
    this.skey = '';
    this.sid = '';
    this.uin = '';
    this.passTicket = '';
    this.baseRequest = null;
    this.my = null;
    this.syncKey = null;
    this.formateSyncKey = '';
    this.deviceid = makeDeviceID();

    // member store
    this.Members = new Datastore();
    this.Contacts = new Datastore();
    this.Groups = new Datastore();
    this.GroupMembers = new Datastore();
    this.Brands = new Datastore(); // 公众帐号
    this.SPs = new Datastore(); // 特殊帐号

    // indexing
    this.Members.ensureIndex({ fieldName: 'UserName', unique: true });
    this.Contacts.ensureIndex({ fieldName: 'UserName', unique: true });
    this.Groups.ensureIndex({ fieldName: 'UserName', unique: true });
    this.Brands.ensureIndex({ fieldName: 'UserName', unique: true });
    this.SPs.ensureIndex({ fieldName: 'UserName', unique: true });

    clearTimeout(this.checkSyncTimer);
    clearInterval(this.updataContactTimer);
  }

  async init() {
    debug('开始登录...');

    this.initConfig();
    try {
      this.uuid = await this.fetchUUID();
    } catch (e) {
      debug('fetch uuid error', e);
      this.init();
      return;
    }

    if (!this.uuid) {
      debug('获取 uuid 失败，正在重试...');
      this.init();
      return;
    }

    debug(`获得 uuid -> ${this.uuid}`);

    const qrcodeUrl = URLS.QRCODE_PATH + this.uuid;
    this.emit('qrcode', qrcodeUrl);

    if (this.receiver) {
      debug(`发送二维码图片到邮箱 ${this.receiver}`);
      this.transporter.sendMail({
        from: `WeixinBot <${this.transporter.transporter.options.auth.user}>`,
        to: this.receiver,
        subject: 'WeixinBot 请求登录',
        html: `<img src="${qrcodeUrl}" height="256" width="256" />`,
      }, (e) => {
        if (e) debug(`发送二维码图片到邮箱 ${this.receiver} 失败`, e);
      });
    } else {
      qrcode.generate(qrcodeUrl.replace('/qrcode/', '/l/'));
    }

    // limit check times
    this.checkTimes = 0;
    while (true) {
      const loginCode = await this.checkLoginStep();
      if (loginCode === 200) break;

      if (loginCode !== 201) this.checkTimes += 1;

      if (this.checkTimes > 6) {
        debug('检查登录状态次数超出限制，重新获取二维码');
        this.init();
        return;
      }
    }

    try {
      debug('正在获取凭据...');
      await this.fetchTickets();
      debug('获取凭据成功!');
    } catch (e) {
      debug('鉴权失败，正在重新登录...', e);
      this.init();
      return;
    }

    debug('开始循环拉取新消息');
    this.runLoop();
  }

  async runLoop() {
    debug('正在初始化参数...');
    try {
      await this.webwxinit();
    } catch (e) {
      debug('登录信息已失效，正在重新获取二维码...');
      this.init();
      return;
    }

    debug('初始化成功!');

    try {
      debug('正在通知客户端网页端已登录...');
      await this.notifyMobile();

      debug('正在获取通讯录列表...');
      await this.fetchContact();
    } catch (e) {
      debug('初始化信息失败，正在重试');
      this.runLoop();
    }

    debug('通知成功!');
    debug('获取通讯录列表成功!');

    // await this.fetchBatchgetContact();
    this.pushHost = await this.lookupSyncCheckHost();

    URLS = getUrls({ baseHost: this.baseHost, pushHost: this.pushHost });

    this.syncCheck();

    // auto update Contacts every ten minute
    this.updataContactTimer = setInterval(() => {
      this.updateContact();
    }, 1000 * 60 * 10);
  }

  async fetchUUID() {
    let result;
    try {
      result = await req.get(URLS.API_jsLogin, {
        params: {
          appid: 'wx782c26e4c19acffb',
          fun: 'new',
          lang: 'zh_CN',
          _: +new Date,
        },
      });
    } catch (e) {
      debug('fetch uuid network error', e);
      // network error retry
      return await this.fetchUUID();
    }

    const { data } = result;

    if (!/uuid = "(.+)";$/.test(data)) {
      throw new Error('get uuid failed');
    }

    const uuid = data.match(/uuid = "(.+)";$/)[1];
    return uuid;
  }

  async checkLoginStep() {
    let result;

    try {
      result = await req.get(URLS.API_login, {
        params: {
          tip: 1,
          uuid: this.uuid,
          _: +new Date,
        },
      });
    } catch (e) {
      debug('checkLoginStep network error', e);
      await this.checkLoginStep();
      return;
    }

    const { data } = result;

    if (!/code=(\d{3});/.test(data)) {
      // retry
      return await this.checkLoginStep();
    }

    const loginCode = parseInt(data.match(/code=(\d{3});/)[1], 10);

    switch (loginCode) {
      case 200:
        debug('已点击确认登录!');
        this.redirectUri = data.match(/redirect_uri="(.+)";$/)[1] + '&fun=new';
        this.baseHost = url.parse(this.redirectUri).host;
        URLS = getUrls({ baseHost: this.baseHost });
        break;

      case 201:
        debug('二维码已被扫描，请确认登录!');
        break;

      case 408:
        debug('检查登录超时，正在重试...');
        break;

      default:
        debug('未知的状态，重试...');
    }

    return loginCode;
  }

  async fetchTickets() {
    let result;
    try {
      result = await req.get(this.redirectUri);
    } catch (e) {
      debug('fetch tickets network error', e);
      // network error, retry
      await this.fetchTickets();
      return;
    }

    const { data } = result;

    if (!/<ret>0<\/ret>/.test(data)) {
      throw new Error('Get skey failed, restart login');
    }

    // const retM = data.match(/<ret>(.*)<\/ret>/);
    // const scriptM = data.match(/<script>(.*)<\/script>/);
    const skeyM = data.match(/<skey>(.*)<\/skey>/);
    const wxsidM = data.match(/<wxsid>(.*)<\/wxsid>/);
    const wxuinM = data.match(/<wxuin>(.*)<\/wxuin>/);
    const passTicketM = data.match(/<pass_ticket>(.*)<\/pass_ticket>/);
    // const redirectUrl = data.match(/<redirect_url>(.*)<\/redirect_url>/);

    this.skey = skeyM && skeyM[1];
    this.sid = wxsidM && wxsidM[1];
    this.uin = wxuinM && wxuinM[1];
    this.passTicket = passTicketM && passTicketM[1];
    debug(`
      获得 skey -> ${this.skey}
      获得 sid -> ${this.sid}
      获得 uid -> ${this.uin}
      获得 pass_ticket -> ${this.passTicket}
    `);

    this.baseRequest = {
      Uin: parseInt(this.uin, 10),
      Sid: this.sid,
      Skey: this.skey,
      DeviceID: this.deviceid,
    };

    fs.writeFileSync(secretPath, JSON.stringify({
      skey: this.skey,
      sid: this.sid,
      uin: this.uin,
      passTicket: this.passTicket,
      baseHost: this.baseHost,
      baseRequest: this.baseRequest,
    }), 'utf8');
  }

  async webwxinit() {
    let result;
    try {
      result = await req.post(
        URLS.API_webwxinit,
        { BaseRequest: this.baseRequest },
        {
          params: {
            pass_ticket: this.passTicket,
            skey: this.skey,
          },
        }
      );
    } catch (e) {
      debug('webwxinit network error', e);
      // network error retry
      await this.webwxinit();
      return;
    }

    const { data } = result;

    if (!data || !data.BaseResponse || data.BaseResponse.Ret !== 0) {
      throw new Error('Init Webwx failed');
    }

    this.my = data.User;
    this.syncKey = data.SyncKey;
    this.formateSyncKey = this.syncKey.List.map((item) => item.Key + '_' + item.Val).join('|');
  }

  async webwxsync() {
    let result;
    try {
      result = await req.post(
        URLS.API_webwxsync,
        {
          BaseRequest: this.baseRequest,
          SyncKey: this.syncKey,
          rr: ~new Date,
        },
        {
          params: {
            sid: this.sid,
            skey: this.skey,
            pass_ticket: this.passTicket,
          },
        }
      );
    } catch (e) {
      debug('webwxsync network error', e);
      // network error retry
      await this.webwxsync();
      return;
    }

    const { data } = result;

    this.syncKey = data.SyncKey;
    this.formateSyncKey = this.syncKey.List.map((item) => item.Key + '_' + item.Val).join('|');

    data.AddMsgList.forEach((msg) => this.handleMsg(msg));
  }

  async lookupSyncCheckHost() {
    for (let host of PUSH_HOST_LIST) {
      let result;
      try {
        result = await req.get('https://' + host + '/cgi-bin/mmwebwx-bin/synccheck', {
          params: {
            r: +new Date,
            skey: this.skey,
            sid: this.sid,
            uin: this.uin,
            deviceid: this.deviceid,
            synckey: this.formateSyncKey,
            _: +new Date,
          },
        });
      } catch (e) {
        debug('lookupSyncCheckHost network error', host);
        // network error retry
        break;
      }

      const { data } = result;

      const retcode = data.match(/retcode:"(\d+)"/)[1];
      if (retcode === '0') return host;
    }
  }

  async syncCheck() {
    let result;
    try {
      result = await req.get(
        URLS.API_synccheck,
        {
          params: {
            r: +new Date(),
            skey: this.skey,
            sid: this.sid,
            uin: this.uin,
            deviceid: this.deviceid,
            synckey: this.syncKey,
            _: +new Date(),
          },
        }
      );
    } catch (e) {
      debug('synccheck network error', e);
      // network error retry
      return await this.syncCheck();
    }

    const { data } = result;

    const retcode = data.match(/retcode:"(\d+)"/)[1];
    const selector = data.match(/selector:"(\d+)"/)[1];

    if (retcode !== '0') {
      debug('你在其他地方登录或登出了微信，正在尝试重新登录...');
      this.runLoop();
      return;
    }

    if (selector !== '0') {
      this.webwxsync();
    }

    clearTimeout(this.checkSyncTimer);
    this.checkSyncTimer = setTimeout(() => {
      this.syncCheck();
    }, 3e3);
  }

  async notifyMobile() {
    let result;
    try {
      result = await req.post(
        URLS.API_webwxstatusnotify,
        {
          BaseRequest: this.baseRequest,
          Code: CODES.StatusNotifyCode_INITED,
          FromUserName: this.my.UserName,
          ToUserName: this.my.UserName,
          ClientMsgId: +new Date,
        },
        {
          params: {
            lang: 'zh_CN',
            pass_ticket: this.passTicket,
          },
        }
      );
    } catch (e) {
      debug('notify mobile network error', e);
      // network error retry
      await this.notifyMobile();
      return;
    }

    const { data } = result;

    if (!data || !data.BaseResponse || data.BaseResponse.Ret !== 0) {
      throw new Error('通知客户端失败');
    }
  }

  async fetchContact() {
    let result;
    try {
      result = await req.post(
        URLS.API_webwxgetcontact,
        {},
        {
          params: {
            pass_ticket: this.passTicket,
            skey: this.skey,
            r: +new Date,
          },
        }
      );
    } catch (e) {
      debug('fetch contact network error', e);
      // network error retry
      await this.fetchContact();
      return;
    }

    const { data } = result;

    if (!data || !data.BaseResponse || data.BaseResponse.Ret !== 0) {
      throw new Error('获取通讯录失败');
    }

    this.Members.insert(data.MemberList);
    this.totalMemberCount = data.MemberList.length;
    this.brandCount = 0;
    this.spCount = 0;
    this.groupCount = 0;
    this.friendCount = 0;
    data.MemberList.forEach((member) => {
      const userName = member.UserName;

      if (member.VerifyFlag & CODES.MM_USERATTRVERIFYFALG_BIZ_BRAND) {
        this.brandCount += 1;
        this.Brands.insert(member);
        return;
      }

      if (SP_ACCOUNTS.includes(userName) || /@qqim$/.test(userName)) {
        this.spCount += 1;
        this.SPs.insert(member);
        return;
      }

      if (userName.includes('@@')) {
        this.groupCount += 1;
        this.Groups.insert(member);
        return;
      }

      if (userName !== this.my.UserName) {
        this.friendCount += 1;
        this.Contacts.insert(member);
      }
    });

    debug(`
      获取通讯录成功
      全部成员数: ${this.totalMemberCount}
      公众帐号数: ${this.brandCount}
      特殊帐号数: ${this.spCount}
      通讯录好友数: ${this.friendCount}
      加入的群聊数(不准确，只有把群聊加入通讯录才会在这里显示): ${this.groupCount}
    `);
  }

  async fetchBatchgetContact(groupIds) {
    const list = groupIds.map((id) => ({ UserName: id, EncryChatRoomId: '' }));
    let result;
    try {
      result = await req.post(
        URLS.API_webwxbatchgetcontact,
        {
          BaseRequest: this.baseRequest,
          Count: list.length,
          List: list,
        },
        {
          params: {
            type: 'ex',
            r: +new Date,
          },
        }
      );
    } catch (e) {
      debug('fetch batchgetcontact network error', e);
      // network error retry
      await this.fetchBatchgetContact(groupIds);
      return;
    }

    const { data } = result;

    if (!data || !data.BaseResponse || data.BaseResponse.Ret !== 0) {
      throw new Error('Fetch batchgetcontact fail');
    }

    data.ContactList.forEach((Group) => {
      this.Groups.insert(Group);
      debug(`获取到群: ${Group.NickName}`);
      debug(`群 ${Group.NickName} 成员数量: ${Group.MemberList.length}`);

      const { MemberList } = Group;
      MemberList.forEach((member) => {
        member.GroupUserName = Group.UserName;
        this.GroupMembers.update({
          UserName: member.UserName,
          GroupUserName: member.GroupUserName,
        }, member, { upsert: true });
      });
    });
  }

  async updateContact() {
    debug('正在更新通讯录');
    try {
      await this.fetchContact();

      const groups = await this.Groups.findAsync({});
      const groupIds = groups.map((group) => group.UserName);
      await this.fetchBatchgetContact(groupIds);
    } catch (e) {
      debug('更新通讯录失败', e);
    }
    debug('更新通讯录成功!');
  }

  async getMember(id) {
    const member = await this.Members.findOneAsync({ UserName: id });

    return member;
  }

  async getGroup(groupId) {
    let group = await this.Groups.findOneAsync({ UserName: groupId });

    if (group) return group;

    try {
      await this.fetchBatchgetContact([groupId]);
    } catch (e) {
      debug('fetchBatchgetContact error', e);
      return null;
    }

    group = await this.Groups.findOneAsync({ UserName: groupId });

    return group;
  }

  async getGroupMember(id, groupId) {
    let member = await this.GroupMembers.findOneAsync({
      UserName: id,
      GroupUserName: groupId,
    });

    if (member) return member;

    try {
      await this.fetchBatchgetContact([groupId]);
    } catch (e) {
      debug('fetchBatchgetContact error', e);
      return null;
    }

    member = await this.GroupMembers.findOneAsync({ UserName: id });

    return member;
  }

  async handleMsg(msg) {
    if (msg.FromUserName.includes('@@')) {
      const userId = msg.Content.match(/^(@[a-zA-Z0-9]+|[a-zA-Z0-9_-]+):<br\/>/)[1];
      msg.GroupMember = await this.getGroupMember(userId, msg.FromUserName);
      msg.Group = await this.getGroup(msg.FromUserName);
      msg.Content = msg.Content.replace(/^(@[a-zA-Z0-9]+|[a-zA-Z0-9_-]+):<br\/>/, '');

      debug(`
        来自群 ${msg.Group.NickName} 的消息
        ${msg.GroupMember.DisplayName || msg.GroupMember.NickName}: ${msg.Content}
      `);

      this.emit('group', msg);
      return;
    }

    msg.Member = await this.getMember(msg.FromUserName);
    if (!msg.Member) return;
    debug(`
      新消息
      ${msg.Member.RemarkName || msg.Member.NickName}: ${msg.Content}
    `);

    this.emit('friend', msg);
    // if (msg.MsgType === CODES.MSGTYPE_SYSNOTICE) {
    //   return;
    // }

    // switch (msg.MsgType) {
    //   case CODES.MSGTYPE_APP:
    //     break;
    //   case CODES.MSGTYPE_EMOTICON:
    //     break;
    //   case CODES.MSGTYPE_IMAGE:
    //     break;
    //   case CODES.MSGTYPE_VOICE:
    //     break;
    //   case CODES.MSGTYPE_VIDEO:
    //     break;
    //   case CODES.MSGTYPE_MICROVIDEO:
    //     break;
    //   case CODES.MSGTYPE_TEXT:
    //     try {
    //       await this.sendText(msg.FromUserName, msg.Content);
    //     } catch (e) {
    //       console.error(e);
    //     }
    //     break;
    //   case CODES.MSGTYPE_RECALLED:
    //     break;
    //   case CODES.MSGTYPE_LOCATION:
    //     break;
    //   case CODES.MSGTYPE_VOIPMSG:
    //   case CODES.MSGTYPE_VOIPNOTIFY:
    //   case CODES.MSGTYPE_VOIPINVITE:
    //     break;
    //   case CODES.MSGTYPE_POSSIBLEFRIEND_MSG:
    //     break;
    //   case CODES.MSGTYPE_VERIFYMSG:
    //     break;
    //   case CODES.MSGTYPE_SHARECARD:
    //     break;
    //   case CODES.MSGTYPE_SYS:
    //     break;
    //   default:
    // }
  }

  sendText(to, content, callback) {
    const clientMsgId = (+new Date + Math.random().toFixed(3)).replace('.', '');

    req.post(URLS.API_webwxsendmsg,
      {
        BaseRequest: this.baseRequest,
        Msg: {
          Type: CODES.MSGTYPE_TEXT,
          Content: content,
          FromUserName: this.my.UserName,
          ToUserName: to,
          LocalID: clientMsgId,
          ClientMsgId: clientMsgId,
        },
      },
      {
        params: {
          pass_ticket: this.passTicket,
        },
      }
    ).then((result) => {
      const { data } = result;
      callback = callback || (() => (null));
      if (!data || !data.BaseResponse || data.BaseResponse.Ret !== 0) {
        return callback(new Error('Send text fail'));
      }

      callback();
    }).catch((e) => {
      debug('send text network error', e);
      // network error, retry
      this.sendText(to, content, callback);
      return;
    });
  }
}

// compatible nodejs require
module.exports = WeixinBot;
