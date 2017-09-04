var util = require('util'),
    Transform = require('stream').Transform;



/**
 * @typedef {('Opus'|'Speex'|'CELT_Alpha'|'CELT_Beta')} Codec
 */

/**
 * The mode of voice transmission.
 * 0 is normal talking.
 * 31 is server loopback.
 * 1-30 when sent from the client is the whisper target.
 * 1-30 when sent from the server: 1 for channel whisper, 2 for direct whisper
 *
 * @typedef {number} VoiceMode
 */

/**
 * Data for a Mumble voice packet.
 * The {@link #source source property} is ignored if this packet is not
 * clientbound otherwise it is required.
 *
 * @typedef {object} VoiceData
 * @property {number} [source] - Session ID of source user
 * @property {VoiceMode} mode - Mode of the voice transmission
 * @property {Codec} codec - Codec used for encoding the voice data
 * @property {number} seqNum - Sequence number of the first voice frame
 * @property {boolean} end - Whether this is the last packet in this transmission
 * @property {Buffer} frames[] - Encoded voice frame
 * @property {object} [position] - Spacial position of the source
 * @property {number} position.x - X coordinate
 * @property {number} position.y - Y coordinate
 * @property {number} position.z - Z coordinate
 */

/**
 * Data for an audio channel ping packet.
 *
 * @typedef {object} PingData
 * @property timestamp The timestamp for this ping packet.
 */


/**
 * Transform stream for encoding {@link VoiceData Mumble voice packets}
 * and {@link PingData audio channel ping packets}.
 *
 * @constructor
 * @constructs Encoder
 * @param {('server'|'client')} dest - Where encoded packets are headed to.
 */
function Encoder(dest) {
  // Allow use without new
  if (!(this instanceof Encoder)) return new Encoder(dest);

  if (dest != 'server' && dest != 'client') {
    throw new TypeError('dest has to be either "server" or "client"');
  }

  Transform.call(this, {
    writableObjectMode: true
  });

  this._dest = dest;
} 
util.inherits(Encoder, Transform);

Encoder.prototype._transform = function(chunk, encoding, callback) {
  var buffer;
  var offset = 0;

  // Special case: Ping packets
  if (chunk.timestamp !== undefined) {
    // Header byte + Timestamp
    buffer = new Buffer(1 + 9);
    offset += buffer.writeUInt8(0x20, offset); // Ping packet header
    offset += toVarint(chunk.timestamp).value.copy(buffer, offset);
    return callback(null, buffer.slice(0, offset));
  }

  var codecId; // Network ID of the codec
  var voiceData; // All voice frames encoded into a single buffer
  if (chunk.codec == 'Opus') {
    if (chunk.frames.length > 1) {
      return callback(new Error('Opus only supports a single frame per packet'));
    }
    var endBit = chunk.end ? 0x2000 : 0
    if (chunk.frames.length == 0) {
      voiceData = toVarint(endBit).value;
    } else {
      var frameSize = toVarint(chunk.frames[0].length | endBit);
      // Opus packets are just the size and the data concatenated
      voiceData = Buffer.concat([frameSize.value, chunk.frames[0]]);
    }
    codecId = 4;
  } else {
    return callback(new TypeError('Unknown codec: ' + chunk.codec));
  }

  // Header byte + Source Session Id + Sequence Number + Voice + Position Data
  buffer = new Buffer(1 + 9 + 9 + voiceData.length + 3 * 4);
  offset += buffer.writeUInt8(codecId << 5 | chunk.mode, offset);
  if (this._dest == 'client') {
    // Only server needs to send the source as the client is not allowed
    // to send voice for anyone besides itself
    offset += toVarint(chunk.source).value.copy(buffer, offset);
  }
  offset += toVarint(chunk.seqNum).value.copy(buffer, offset);
  offset += voiceData.copy(buffer, offset);
  if (chunk.position) {
    offset += buffer.writeFloatBE(chunk.position.x, offset);
    offset += buffer.writeFloatBE(chunk.position.y, offset);
    offset += buffer.writeFloatBE(chunk.position.z, offset);
  }
  // Trim buffer to actual length and pass through
  callback(null, buffer.slice(0, offset));
};

/**
 * Transform stream for decoding {@link VoiceData Mumble voice packets}
 * and {@link PingData audio channel ping packets}.
 *
 * @constructor
 * @constructs Decoder
 * @param {('server'|'client')} orig - Where encoded packets are coming from.
 */
function Decoder(orig) {
  // Allow use without new
  if (!(this instanceof Decoder)) return new Decoder(orig);

  if (orig != 'server' && orig != 'client') {
    throw new TypeError('orig has to be either "server" or "client"');
  }

  Transform.call(this, {
    readableObjectMode: true
  });

  this._orig = orig;
} 
util.inherits(Decoder, Transform);

Decoder.prototype._transform = function(chunk, encoding, callback) {
  var packet = {};
  try {
    var codecId = chunk[0] >> 5;
    if (codecId == 1) { // Ping packet
      packet.timestamp = fromVarint(chunk.slice(1)).value;
    } else { // Voice packet
      var target = chunk[0] & 0x1f
      packet.target = ['normal', 'shout', 'whisper'][target] || 'loopback';
      var offset = 1;

      // Parse source if this packet originated from the server
      if (this._orig == 'server') {
        var source = fromVarint(chunk.slice(offset));
        offset += source.length;
        packet.source = source.value;
      }

      // Parse the sequence number of the first audio packet
      var sequenceNumber = fromVarint(chunk.slice(offset));
      offset += sequenceNumber.length;
      packet.seqNum = sequenceNumber.value;

      // Parse the voice frames depending on the audio codec
      if (codecId == 4) {
        var voiceLength = fromVarint(chunk.slice(offset));
        packet.end = (voiceLength.value & 0x2000) > 0;
        voiceLength.value &= 0x1fff;
        offset += voiceLength.length;
        var voice = chunk.slice(offset, offset + voiceLength.value);
        offset += voiceLength.value;
        packet.frames = [voice];
        packet.codec = 'Opus';
      } else {
        throw new Error('Unknown codec: ' + codecId);
      }

      // Parse positional data if existent
      if (chunk.length > offset + 12) {
        packet.position = {
          x: chunk.readFloatBE(offset),
          y: chunk.readFloatBE(offset + 4),
          z: chunk.readFloatBE(offset + 8)
        };
      }
    }
  } catch (e) {
    return callback(e);
  }
  return callback(null, packet);
};

module.exports = {
  Encoder: Encoder,
  Decoder: Decoder
};

// Functions below from node-mumble
// https://github.com/Rantanen/node-mumble/blob/master/LICENSE

/**
 * @summary Converts a number to Mumble varint.
 *
 * @see {@link http://mumble-protocol.readthedocs.org/en/latest/voice_data.html#variable-length-integer-encoding}
 *
 * @param {number} i - Integer to convert
 * @returns {Buffer} Varint encoded number
 */
function toVarint( i ) {

    var arr = [];
    if( i < 0 ) {
        i = ~i;
        if( i <= 0x3 ) { return new Buffer( [ 0xFC | i ] ); }

        arr.push( 0xF8 );
    }

    if( i < 0x80 ) {
        arr.push( i );
    } else if( i < 0x4000 ) {
        arr.push( ( i >> 8 ) | 0x80 );
        arr.push( i & 0xFF );
    } else if( i < 0x200000 ) {
        arr.push( ( i >> 16 ) | 0xC0 );
        arr.push( ( i >> 8 ) & 0xFF );
        arr.push( i & 0xFF );
    } else if( i < 0x10000000 ) {
        arr.push( ( i >> 24 ) | 0xE0 );
        arr.push( ( i >> 16 ) & 0xFF );
        arr.push( ( i >> 8 ) & 0xFF );
        arr.push( i & 0xFF );
    } else if( i < 0x100000000 ) {
        arr.push( 0xF0 );
        arr.push( ( i >> 24 ) & 0xFF );
        arr.push( ( i >> 16 ) & 0xFF );
        arr.push( ( i >> 8 ) & 0xFF );
        arr.push( i & 0xFF );
    } else {
        throw new TypeError( 'Non-integer values are not supported. (' + i + ')' );
    }

    return {
        value: new Buffer( arr ),
        length: arr.length
    };
}

/**
 * @summary Converts a Mumble varint to an integer.
 *
 * @see {@link http://mumble-protocol.readthedocs.org/en/latest/voice_data.html#variable-length-integer-encoding}
 *
 * @param {Buffer} b - Varint to convert
 * @returns {number} Decoded integer
 */
function fromVarint( b ) {
    var length = 1;
    var i, v = b[ 0 ];
    if( ( v & 0x80 ) === 0x00 ) {
        i = ( v & 0x7F );
    } else if( ( v & 0xC0 ) === 0x80 ) {
        i = ( v & 0x3F ) << 8 | b[ 1 ];
        length = 2;
    } else if( ( v & 0xF0 ) === 0xF0 ) {
        switch( v & 0xFC ) {
        case 0xF0:
            i = b[ 1 ] << 24 | b[ 2 ] << 16 | b[ 3 ] << 8 | b[ 4 ];
            length = 5;
            break;
        case 0xF8:
            var ret = fromVarint( b.slice( 1 ) );
            return {
                value: ~ret.value,
                length: 1 + ret.length
            };
        case 0xFC:
            i = v & 0x03;
            i = ~i;
            break;
        case 0xF4:
            throw new TypeError(
                '64-bit varints are not supported. (' + b.slice( 1, 6 ) + ')' );
        default:
            throw new TypeError( 'Unknown varint' );
        }
    } else if( ( v & 0xF0 ) === 0xE0 ) {
        i = ( v & 0x0F ) << 24 | b[ 1 ] << 16 | b[ 2 ] << 8 | b[ 3 ];
        length = 4;
    } else if( ( v & 0xE0 ) === 0xC0 ) {
        i = ( v & 0x1F ) << 16 | b[ 1 ] << 8 | b[ 2 ];
        length = 3;
    }

    return {
        value: i,
        length: length
    };
}
