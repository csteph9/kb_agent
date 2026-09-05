import Ajv from 'ajv';
import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { appDir, validId } from './config.js';

export async function loadConnector(source) {
  if (!validId(source.connector)) throw new Error('Invalid connector ID');
  const dir = path.join(appDir, 'connectors', source.connector);
  const manifest = JSON.parse(await fs.readFile(path.join(dir, 'manifest.json'), 'utf8'));
  if (manifest.id !== source.connector || manifest.apiVersion !== 1) throw new Error('Unsupported connector manifest');
  const validate = new Ajv({ allErrors: true }).compile(manifest.configSchema || { type: 'object' });
  if (!validate(source.config)) throw new Error('Invalid connector configuration: ' + JSON.stringify(validate.errors.map(e => ({ path: e.instancePath, message: e.message }))));
  const module = await import(pathToFileURL(path.join(dir, 'connector.js')).href);
  if (typeof module.createConnector !== 'function') throw new Error('Connector must export createConnector');
  const connector = await module.createConnector(source);
  if (typeof connector.fetchPage !== 'function' || typeof connector.check !== 'function') throw new Error('Invalid connector interface');
  return connector;
}
