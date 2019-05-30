/**
 * Created by admin on 2019/5/30.
 */
var request = require('request');

const url='http://openapi.tuling123.com/openapi/api/v2';


var tulingSend=function(msg){
  var requestData={
    "reqType":0,
    "perception": {
      "inputText": {
        "text": msg
      },
      "selfInfo": {
        "location": {
          "city": "北京",
          "province": "北京",
          "street": "信息路"
        }
      }
    },
    "userInfo": {
      "apiKey": "",
      "userId": ""
    }
  };

  var promise = new Promise(function (resolve, reject) {
    request({
      url: url,//请求路径
      method: "POST",//请求方式，默认为get
      headers: {//设置请求头
        "content-type": "application/json",
      },
      body: JSON.stringify(requestData)//post参数字符串
    }, function(error, response, body) {
      if (!error && response.statusCode == 200) {
        resolve(JSON.parse(response.body));
      }else{
        reject(error);
      }
    });
  });
  return promise;
};

exports.tulingSend=tulingSend;

