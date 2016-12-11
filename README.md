# mumble-streams

This module provides node-style streams for en- and decoding the Mumble protocol.

### Usage

See [here](https://github.com/johni0702/mumble-client/blob/master/src/client.js) for a working example.

```javascript
import mumbleStreams from 'mumble-streams'

var encoder = new mumbleStreams.data.Encoder()
var decoder = new mumbleStreams.data.Decoder()

encoder.pipe(decoder).on('data', data => {
  console.log(data)
});

encoder.write({
  name: 'Version',
  payload: {
    version: mumbleStreams.version.toUInt8(),                               
    release: 'mumble-streams',       
    os: 'node.js',                                
    os_version: ''
  }
})
```

### License
ISC
