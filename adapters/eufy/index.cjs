// Keep upstream build paths out of business capabilities and presentation code.
const { Station, Camera, Device, DeviceType, DeviceCommands, CommandName, MegaHTTPApi, ResponseErrorCode } = require('../../vendor/eufy-security-client/build/http');
const { P2PConnectionType, CommandType, P2PClientProtocol } = require('../../vendor/eufy-security-client/build/p2p');

module.exports = { Station, Camera, Device, DeviceType, DeviceCommands, CommandName, MegaHTTPApi, ResponseErrorCode, P2PConnectionType, CommandType, P2PClientProtocol };
