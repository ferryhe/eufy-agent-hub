const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { Readable } = require('node:stream');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { LocalRecordings } = require('./events.cjs');
const { Station, CommandType } = require('../../adapters/eufy');

test('date query retains default count and sends explicit higher limit', () => {
  const sent = [];
  const station = { hasCommand: () => true, getSerial: () => 'BASE', rawStation: {member:{admin_user_id:'test'}}, p2pSession: {sendCommandWithStringPayload: value => sent.push(JSON.parse(value.value))} };
  Station.prototype.databaseQueryByDate.call(station, ['CAMERA'], new Date(2026,7,27), new Date(2026,7,28));
  Station.prototype.databaseQueryByDate.call(station, ['CAMERA'], new Date(2026,7,27), new Date(2026,7,28),0,0,0,1000);
  assert.deepEqual(sent.map(item => item.payload.payload.count), [100,1000]);
  assert.throws(() => Station.prototype.databaseQueryByDate.call(station, [], new Date(), new Date(),0,0,0,10001), RangeError);
});

test('query expands beyond 1000 and excludes firmware results from other cameras', async () => {
  const service = new LocalRecordings({});
  const station = new EventEmitter(); station.getSerial = () => 'BASE'; service.station = station; service.connect = async () => {};
  const own = {record_id:1,device_sn:'CAMERA',station_sn:'BASE'};
  const wrong = {record_id:2,device_sn:'OTHER',station_sn:'BASE'};
  station.databaseQueryByDate = (_sn,_start,_end,_event,_detection,_storage,count) => station.emit('database query by date',station,0,count === 1000 ? Array(1000).fill(wrong) : [own,...Array(1000).fill(wrong)]);
  assert.deepEqual(await service.listDay('CAMERA','2026-08-27'), [own]);
  station.databaseQueryByDate = () => station.emit('database query by date',station,7,[]);
  await assert.rejects(service.listDay('CAMERA','2026-08-27'), /7/);
  assert.deepEqual(service.records, []);
});

test('download finish without device confirmation is not successful', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(),'eufy-download-test-'));
  t.after(() => fs.rmSync(directory,{recursive:true,force:true}));
  const service = new LocalRecordings({});
  service.camera = {getSerial:()=>'CAMERA',getChannel:()=>1};
  const station = new EventEmitter(); service.station = station;
  station.isConnected = () => true; station.cancelDownload = () => {};
  service.records = [{record_id:1,device_sn:'CAMERA',storage_path:'/record',start_time:new Date(),end_time:new Date()}];
  let confirmed = false;
  station.startDownload = async () => {
    station.emit('download start',station,1,{videoCodec:1},Readable.from(['video']),Readable.from(['audio']));
    station.emit('download finish',station,1);
    setImmediate(() => {
      if (confirmed) station.emit('download complete',station,1);
      else station.emit('command result',station,{channel:1,command_type:CommandType.CMD_DOWNLOAD_VIDEO,return_code:9});
    });
  };
  await assert.rejects(service.download(1,directory), /9/);
  assert.equal(fs.existsSync(path.join(directory,'1.json')),false);
  // Let both failed attempt output streams settle before reusing the paths.
  await new Promise(resolve => setTimeout(resolve,30));
  confirmed = true;
  const result = await service.download(1,directory);
  assert.equal(result.complete,true);
  assert.equal(JSON.parse(fs.readFileSync(path.join(directory,'1.json'))).complete,true);
});
