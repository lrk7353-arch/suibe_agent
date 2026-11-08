const fs = require('node:fs');
const path = require('node:path');

const configPath = process.env.XIAOMAO_CONFIG || path.join(__dirname, 'config/app.config.json');
const config = JSON.parse(fs.readFileSync(configPath, 'utf8').replace(/^\uFEFF/, ''));

function port(name, fallback) {
  const value = process.env['XIAOMAO_PORT_' + name.toUpperCase()] || config.ports?.[name] || fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65535) throw Error('invalid port for ' + name);
  return parsed;
}

const host = process.env.XIAOMAO_HOST || config.host || '127.0.0.1';
const ports = { web: port('web', 18766), rag: port('rag', 18767), model: port('model', 18768) };

module.exports = {
  config,
  configPath,
  host,
  ports,
  webBase: `http://${host}:${ports.web}`,
  ragBase: `http://${host}:${ports.rag}`,
  modelBase: process.env.XIAOMAO_MODEL_URL || `http://${host}:${ports.model}`,
  offline: process.env.XIAOMAO_OFFLINE === '1',
};
