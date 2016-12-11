var fs = require('fs'),
    protobufjs = require('protobufjs'),
    util = require('util'),
    Transform = require('stream').Transform;

var nameById = {
    0: 'Version',
    1: 'UDPTunnel',
    2: 'Authenticate',
    3: 'Ping',
    4: 'Reject',
    5: 'ServerSync',
    6: 'ChannelRemove',
    7: 'ChannelState',
    8: 'UserRemove',
    9: 'UserState',
    10: 'BanList',
    11: 'TextMessage',
    12: 'PermissionDenied',
    13: 'ACL',
    14: 'QueryUsers',
    15: 'CryptSetup',
    16: 'ContextActionModify',
    17: 'ContextAction',
    18: 'UserList',
    19: 'VoiceTarget',
    20: 'PermissionQuery',
    21: 'CodecVersion',
    22: 'UserStats',
    23: 'RequestBlob',
    24: 'ServerConfig',
    25: 'SuggestConfig'
};
var idByName = {};
for (var id in nameById) {
	idByName[nameById[id]] = id;
}

// Explicitly reading with readFileSync to support brfs
var mumbleProto = fs.readFileSync(__dirname + '/Mumble.proto');
var messages = protobufjs.loadProto(mumbleProto).build('MumbleProto');

/**
 * Encodes the given message.
 *
 * @param {string} name The name of the message.
 * @param {object} payload The message to be encoded.
 * @return {Buffer} The encoded message.
 */
function encode(name, payload) {
  var encoded = new messages[name](payload || {}).toBuffer();
  // toBuffer returns an ArrayBuffer when called in the browser
  if (!Buffer.isBuffer(encoded)) {
    encoded = Buffer.from(encoded);
  }
	return encoded;
}

/**
 * A message object.
 * @typedef {object} Message
 * @property {string} name - Name of the message
 * @property {object} [payload={}] - Payload of the message
 */

/**
 * Decodes the given message.
 *
 * @param {number} id The id of the message.
 * @param {Buffer} payload The encoded message.
 * @return {object} The decoded message.
 */
function decode(id, payload) {
	var name = nameById[id];
	return new messages[name].decode(payload || {});
}

/**
 * Transform stream for encoding {@link Message Mumble messages}.
 *
 * @constructor
 * @constructs Encoder
 */
function Encoder() {
  // Allow use without new
  if (!(this instanceof Encoder)) return new Encoder();

  Transform.call(this, {
    writableObjectMode: true
  });
}
util.inherits(Encoder, Transform);

Encoder.prototype._transform = function(chunk, encoding, callback) {
  if (typeof chunk.name !== 'string') {
    return callback(new TypeError('chunk.name is not a string'));
  }
  chunk.payload = chunk.payload || {};

  // First, encode the payload
  var data;
  if (chunk.name == 'UDPTunnel') {
    // UDPTunnel message doesn't need encoding
    data = chunk.payload;
  } else {
    try {
      // Encode the message payload
      data = encode(chunk.name, chunk.payload);
    } catch (e) {
      callback(e);
      return;
    }
  }

  // Then create the header
  var header = new Buffer(6);
  header.writeUInt16BE(idByName[chunk.name], 0);
  header.writeUInt32BE(data.length, 2);

  callback(null, Buffer.concat([header, data]));
};

/**
 * Transform stream for decoding {@link Message Mumble messages}.
 *
 * @constructor
 * @constructs Decoder
 */
function Decoder() {
  // Allow use without new
  if (!(this instanceof Decoder)) return new Decoder();

  Transform.call(this, {
    readableObjectMode: true
  });

	this._buffer = new Buffer(1024);
	this._bufferSize = 0;
}
util.inherits(Decoder, Transform);

Decoder.prototype._transform = function(chunk, encoding, callback) {
  // Add incoming chunk to internal buffer
	if (this._buffer.length - this._bufferSize < chunk.length) {
    // Old buffer is too small, replace with bigger one
		var oldBuffer = this._buffer;
		this._buffer = new Buffer(this._bufferSize + chunk.length);
		oldBuffer.copy(this._buffer, 0, 0, this._bufferSize);
	}
	this._bufferSize += chunk.copy(this._buffer, this._bufferSize);


  // Try to decode messages while we still have enough bytes
	while (this._bufferSize >= 6) {
		var type = this._buffer.readUInt16BE(0);
		var size = this._buffer.readUInt32BE(2);
		if (this._bufferSize < 6 + size) {
			break; // Not enough bytes in internal buffer for the expected payload
		}

		var typeName = nameById[type];
		var data = this._buffer.slice(6, 6 + size);
    // Decode payload
		var message;
    if (typeName == 'UDPTunnel') {
      // UDPTunnel payload is not encoded
		  message = new Buffer(data);
    } else {
      try {
		    message = decode(type, data);
      } catch (e) {
        return callback(e);
      }
    }

    // Shift remaining bytes to start of internal buffer
		this._buffer.copy(this._buffer, 0, 6 + size, this._bufferSize);
		this._bufferSize -= 6 + size;

    this.push({
      name: typeName,
      payload: message
    });
	}
  callback();
};

module.exports = {
  Encoder: Encoder,
  Decoder: Decoder,
  messages: messages
};
