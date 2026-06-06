'use strict';

const dgram = require('dgram');
const http = require('http');
const {
  URL
} = require('url');
const SSDP_ADDRESS = '239.255.255.250';
const SSDP_PORT = 1900;
const SEARCH_TIMEOUT = 4000;
function discoverGateway() {
  return new Promise((resolve, reject) => {
    const socket = dgram.createSocket({
      type: 'udp4',
      reuseAddr: true
    });
    let found = false;
    const searchMsg = Buffer.from(['M-SEARCH * HTTP/1.1', `HOST: ${SSDP_ADDRESS}:${SSDP_PORT}`, 'MAN: "ssdp:discover"', 'MX: 3', 'ST: urn:schemas-upnp-org:device:InternetGatewayDevice:1', '', ''].join('\r\n'));
    const timer = setTimeout(() => {
      socket.close();
      if (!found) reject(new Error('UPnP gateway not found'));
    }, SEARCH_TIMEOUT);
    socket.on('message', msg => {
      if (found) return;
      const text = msg.toString();
      const locMatch = text.match(/LOCATION:\s*(.*)/i);
      if (locMatch) {
        found = true;
        clearTimeout(timer);
        socket.close();
        resolve(locMatch[1].trim());
      }
    });
    socket.on('error', err => {
      clearTimeout(timer);
      socket.close();
      reject(err);
    });
    socket.bind(() => {
      socket.addMembership(SSDP_ADDRESS);
      socket.send(searchMsg, 0, searchMsg.length, SSDP_PORT, SSDP_ADDRESS);
    });
  });
}
function httpGet(url) {
  return new Promise((resolve, reject) => {
    http.get(url, res => {
      let body = '';
      res.on('data', d => body += d);
      res.on('end', () => resolve(body));
    }).on('error', reject);
  });
}
function httpPost(url, body, soapAction) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const options = {
      hostname: u.hostname,
      port: u.port || 80,
      path: u.pathname,
      method: 'POST',
      headers: {
        'Content-Type': 'text/xml; charset="utf-8"',
        'Content-Length': Buffer.byteLength(body),
        SOAPAction: `"${soapAction}"`
      }
    };
    const req = http.request(options, res => {
      let data = '';
      res.on('data', d => data += d);
      res.on('end', () => resolve(data));
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}
function parseControlUrl(xml, baseUrl) {
  const serviceTypes = ['urn:schemas-upnp-org:service:WANIPConnection:1', 'urn:schemas-upnp-org:service:WANPPPConnection:1'];
  for (const st of serviceTypes) {
    const idx = xml.indexOf(st);
    if (idx === -1) continue;
    const ctrlMatch = xml.slice(idx).match(/<controlURL>(.*?)<\/controlURL>/i);
    if (ctrlMatch) {
      const ctrlPath = ctrlMatch[1];
      const u = new URL(baseUrl);
      return `http://${u.hostname}:${u.port || 80}${ctrlPath}`;
    }
  }
  return null;
}
function getServiceType(xml) {
  if (xml.includes('WANPPPConnection')) return 'urn:schemas-upnp-org:service:WANPPPConnection:1';
  return 'urn:schemas-upnp-org:service:WANIPConnection:1';
}
function soapAddPortMapping(controlUrl, serviceType, externalPort, internalIP, internalPort, description, leaseDuration) {
  const body = `<?xml version="1.0"?>
<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/" s:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/">
  <s:Body>
    <u:AddPortMapping xmlns:u="${serviceType}">
      <NewRemoteHost></NewRemoteHost>
      <NewExternalPort>${externalPort}</NewExternalPort>
      <NewProtocol>TCP</NewProtocol>
      <NewInternalPort>${internalPort}</NewInternalPort>
      <NewInternalClient>${internalIP}</NewInternalClient>
      <NewEnabled>1</NewEnabled>
      <NewPortMappingDescription>${description}</NewPortMappingDescription>
      <NewLeaseDuration>${leaseDuration}</NewLeaseDuration>
    </u:AddPortMapping>
  </s:Body>
</s:Envelope>`;
  return httpPost(controlUrl, body, `${serviceType}#AddPortMapping`);
}
function soapGetExternalIP(controlUrl, serviceType) {
  const body = `<?xml version="1.0"?>
<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/" s:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/">
  <s:Body>
    <u:GetExternalIPAddress xmlns:u="${serviceType}">
    </u:GetExternalIPAddress>
  </s:Body>
</s:Envelope>`;
  return httpPost(controlUrl, body, `${serviceType}#GetExternalIPAddress`);
}
function soapDeletePortMapping(controlUrl, serviceType, externalPort) {
  const body = `<?xml version="1.0"?>
<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/" s:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/">
  <s:Body>
    <u:DeletePortMapping xmlns:u="${serviceType}">
      <NewRemoteHost></NewRemoteHost>
      <NewExternalPort>${externalPort}</NewExternalPort>
      <NewProtocol>TCP</NewProtocol>
    </u:DeletePortMapping>
  </s:Body>
</s:Envelope>`;
  return httpPost(controlUrl, body, `${serviceType}#DeletePortMapping`);
}
class UPnPMapper {
  constructor() {
    this.controlUrl = null;
    this.serviceType = null;
    this.mappedPort = null;
  }
  async discover() {
    const location = await discoverGateway();
    const xml = await httpGet(location);
    this.controlUrl = parseControlUrl(xml, location);
    this.serviceType = getServiceType(xml);
    if (!this.controlUrl) throw new Error('Could not find WANIPConnection control URL');
    return true;
  }
  async getExternalIP() {
    if (!this.controlUrl) await this.discover();
    const response = await soapGetExternalIP(this.controlUrl, this.serviceType);
    const match = response.match(/<NewExternalIPAddress>(.*?)<\/NewExternalIPAddress>/);
    return match ? match[1] : null;
  }
  async addMapping(externalPort, internalIP, internalPort, description = 'SafeBox', leaseDuration = 10800) {
    if (!this.controlUrl) await this.discover();
    await soapAddPortMapping(this.controlUrl, this.serviceType, externalPort, internalIP, internalPort, description, leaseDuration);
    this.mappedPort = externalPort;
  }
  async removeMapping(externalPort) {
    if (!this.controlUrl) return;
    try {
      await soapDeletePortMapping(this.controlUrl, this.serviceType, externalPort || this.mappedPort);
    } catch (_) {}
  }
}
module.exports = {
  UPnPMapper
};