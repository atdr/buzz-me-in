// based on https://github.com/twilio/media-streams/blob/master/node/basic/README.md
"use strict";

const fs = require('fs');
const path = require('path');
var http = require('http');
var HttpDispatcher = require('httpdispatcher');
var WebSocketServer = require('websocket').server;
const child_process = require('child_process');

var dispatcher = new HttpDispatcher();
var wsserver = http.createServer(handleRequest);

const HTTP_SERVER_PORT = 8080;

var mediaws = new WebSocketServer({
  httpServer: wsserver,
  autoAcceptConnections: true,
});

function log(message, ...args) {
  console.log(new Date(), message, ...args);
}

function handleRequest(request, response){
  try {
    dispatcher.dispatch(request, response);
  } catch(err) {
    console.error(err);
  }
}

dispatcher.onPost('/twiml', function(req,res) {
  log('POST TwiML');

  var filePath = path.join(__dirname+'/templates', 'streams.xml');
  var stat = fs.statSync(filePath);

  res.writeHead(200, {
    'Content-Type': 'text/xml',
    'Content-Length': stat.size
  });

  var readStream = fs.createReadStream(filePath);
  readStream.pipe(res);
});

mediaws.on('connect', function(connection) {
  log('Media WS: Connection accepted');
  new MediaStream(connection);
});

class MediaStream {
  constructor(connection) {
    connection.on('message', this.processMessage.bind(this));
    connection.on('close', this.close.bind(this));
    this.hasSeenMedia = false;
    this.messageCount = 0;
    
    // start FFmpeg
    // implementation from https://github.com/fbsamples/Canvas-Streaming-Example/blob/master/README.md
    this.ffmpeg = child_process.spawn('ffmpeg', [
      // testing options
      '-y', '-loglevel', 'verbose',
    
      // audio input format https://stackoverflow.com/q/60955908
      '-f', 'mulaw', '-ar', 8000, '-ac', 1, '-bits_per_raw_sample', 8,
      
      // FFmpeg will read input from STDIN
      '-i', '-',
      
      // audio output format
      '-af', 'aresample=resampler=soxr', '-ar', 16000,
      
      // output destination
      'audio.wav'
    ]);
    
    // If FFmpeg stops for any reason, close the WebSocket connection.
    this.ffmpeg.on('close', (code, signal) => {
      console.log('FFmpeg child process closed, code ' + code + ', signal ' + signal);
      this.close();
    });
    
    // Handle STDIN pipe errors by logging to the console.
    // These errors most commonly occur when FFmpeg closes and there is still
    // data to write.  If left unhandled, the server will crash.
    this.ffmpeg.stdin.on('error', (e) => {
      console.log('FFmpeg STDIN Error', e);
    });
    
    // FFmpeg outputs all of its messages to STDERR.  Let's log them to the console.
    this.ffmpeg.stderr.on('data', (data) => {
      console.log('FFmpeg STDERR:', data.toString());
    });
  }

  processMessage(message){
    if (message.type === 'utf8') {
      var data = JSON.parse(message.utf8Data);
      if (data.event === "connected") {
        log('Media WS: Connected event received: ', data);
      }
      if (data.event === "start") {
        log('Media WS: Start event received: ', data);
      }
      if (data.event === "media") {
        if (!this.hasSeenMedia) {
          log('Media WS: Media event received: ', data);
          log('Media WS: Suppressing additional messages...');
          this.hasSeenMedia = true;
        }

        // consume stream https://www.twilio.com/docs/voice/tutorials/consume-real-time-media-stream-using-websockets-python-and-flask
        var payload_b64 = data.media.payload;
        var payload = Buffer.from(payload_b64, 'base64'); // https://stackoverflow.com/a/14573049
        this.ffmpeg.stdin.write(payload);

      }
      if (data.event === "stop") {
        log('Media WS: Stop event received: ', data);
      }
      this.messageCount++;
    } else if (message.type === 'binary') {
      log('Media WS: binary message received (not supported)');
    }
  }

  close(){
    log('Media WS: Stopped. Received a total of [' + this.messageCount + '] messages');
    this.ffmpeg.kill('SIGINT');
  }
}

wsserver.listen(HTTP_SERVER_PORT, function(){
  console.log("Server listening on: http://localhost:%s", HTTP_SERVER_PORT);
});
