require('reify');
require('async-to-gen/register');
var tuling = require('./tuling');

const Weixinbot = require('../src/weixinbot');

const bot = new Weixinbot();

bot.on('qrcode', console.log);

bot.on('friend', (msg) => {
  console.log(msg.Member.NickName + ': ' + msg.Content);
  //bot.sendText(msg.FromUserName, 'Got it');

  tuling.tulingSend(msg.Content).then((data)=>{
    console.log(11111);
    var arr=data.results;
    var temp=[];
    arr.map((item)=>{
      if(item.values){
        temp.push(item.values.text);
      }
    });
    //var value=data.results[0].values.text;
    var str=temp.join(',');
    console.log(msg.FromUserName+ ': ' +str);
    bot.sendText(msg.FromUserName,str);
  })
  //bot.sendText(msg.FromUserName, result.results);
});

bot.run();
