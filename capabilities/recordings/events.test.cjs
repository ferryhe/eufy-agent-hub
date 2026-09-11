const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { Readable } = require('node:stream');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { LocalRecordings } = require('./events.cjs');
const { Station, CommandType, DeviceType, CommandName } = require('../../adapters/eufy');

test('HB3 download sends the account-bound payload with the camera channel and RSA key', async () => {
  const sent = [];
  const camera = {
    getSerial: () => 'CAMERA', getStationSerial: () => 'BASE', getChannel: () => 1,
    hasCommand: name => name === CommandName.DeviceStartDownload,
  };
  const station = {
    getSerial: () => 'BASE', getDeviceType: () => DeviceType.HB3,
    rawStation: { member: { admin_user_id: 'fixture-account' } },
    api: { getCipher: () => assert.fail('HB3 must not use the legacy cloud cipher lookup') },
    p2pSession: {
      getDownloadRSAPrivateKey: () => ({ exportKey: () => ({ n: Buffer.from([0, 0xab, 0xcd]) }) }),
      sendCommandWithStringPayload: (request, metadata) => sent.push({ request, metadata }),
    },
  };
  await Station.prototype.startDownload.call(station, camera, '/fixture/event.dat', 7);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].request.commandType, CommandType.CMD_SET_PAYLOAD);
  assert.equal(sent[0].request.channel, 1);
  assert.deepEqual(JSON.parse(sent[0].request.value), {
    account_id: 'fixture-account', cmd: CommandType.CMD_DOWNLOAD_VIDEO, mChannel: 1,
    mValue3: CommandType.CMD_DOWNLOAD_VIDEO, payload: { filepath: '/fixture/event.dat', key: 'ABCD' },
  });
  assert.equal(sent[0].metadata.command.name, CommandName.DeviceStartDownload);
});

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
      else station.emit('command result',station,{channel:1,command_type:CommandType.CMD_DOWNLOAD_VIDEO,return_code:-104});
    });
  };
  await assert.rejects(service.download(1,directory), /-104/);
  assert.equal(fs.existsSync(path.join(directory,'1.json')),false);
  // Let both failed attempt output streams settle before reusing the paths.
  await new Promise(resolve => setTimeout(resolve,30));
  confirmed = true;
  const window = require('./time-window.cjs').normalizeWindow({day:'2026-08-27',start:'16:30',end:'16:50',timezone:'Asia/Shanghai'});
  const result = await service.download(1,directory,window);
  assert.equal(result.complete,true);
  assert.equal(JSON.parse(fs.readFileSync(path.join(directory,'1.json'))).complete,true);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(directory,'1.json'))).window,window);
});

test('query translates caller instants to protocol calendar dates in each station process timezone', () => {
  const { spawnSync } = require('node:child_process');
  const script = `
    const { LocalRecordings } = require('./capabilities/recordings/events.cjs');
    const { Station } = require('./adapters/eufy');
    const { normalizeWindow } = require('./capabilities/recordings/time-window.cjs');
    const { EventEmitter } = require('node:events');
    const service = new LocalRecordings({}), station = new EventEmitter();
    station.getSerial = () => 'BASE'; station.hasCommand = () => true;
    station.rawStation = {member:{admin_user_id:'fixture'}};
    const rows = [
      {record_id:1,device_sn:'CAMERA',station_sn:'BASE',start_time:new Date('2026-08-26T16:15:00Z'),end_time:new Date('2026-08-26T16:20:00Z')},
      {record_id:2,device_sn:'CAMERA',station_sn:'BASE',start_time:new Date('2026-08-27T04:00:00Z'),end_time:new Date('2026-08-27T04:10:00Z')},
      {record_id:3,device_sn:'CAMERA',station_sn:'BASE',start_time:new Date('2026-08-27T05:00:00Z'),end_time:new Date('2026-08-27T05:10:00Z')}
    ];
    const payloads = [];
    station.p2pSession = {sendCommandWithStringPayload: request => {
      payloads.push(JSON.parse(request.value).payload.payload);
      station.emit('database query by date', station, 0, rows);
    }};
    station.databaseQueryByDate = Station.prototype.databaseQueryByDate;
    service.station = station; service.connect = async () => {};
    (async () => {
      const window = normalizeWindow({day:'2026-08-27',start:'00:10',end:'13:00',timezone:'Asia/Shanghai'});
      const result = await service.listWindow('CAMERA',window);
      await service.listDay('CAMERA','2026-08-27');
      console.log(JSON.stringify({payloads,ids:result.map(row=>row.record_id)}));
    })().catch(error => {console.error(error);process.exitCode=1;});
  `;
  for (const [timezone, startDate] of [['America/Toronto','20260826'], ['UTC','20260826'], ['Asia/Shanghai','20260827']]) {
    const child = spawnSync(process.execPath, ['-e', script], {cwd:path.join(__dirname,'../..'), env:{...process.env,TZ:timezone},encoding:'utf8'});
    assert.equal(child.status,0,child.stderr);
    const {payloads,ids} = JSON.parse(child.stdout);
    assert.equal(payloads[0].start_date,startDate,timezone);
    assert.equal(payloads[0].end_date,'20260828',timezone);
    assert.equal(payloads[0].start_time,`${startDate}000000`);
    assert.equal(payloads[1].start_date,'20260827','legacy calendar date must not shift');
    assert.equal(payloads[1].end_date,'20260828');
    assert.deepEqual(ids,[1,2]);
  }
});

test('day query rejects impossible calendar dates before connecting', async () => {
  const service = new LocalRecordings({});
  service.connect = async () => { throw new Error('connected with invalid date'); };
  await assert.rejects(service.listDay('CAMERA', '2026-02-30'), error => error.i18n?.key === 'service.recordings.invalidDate');
});
