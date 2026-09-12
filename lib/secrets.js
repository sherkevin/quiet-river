'use strict';

const fs = require('node:fs');
const path = require('node:path');

const SECRETS_DIR = path.join(__dirname, '..', 'secrets');

// 环境变量优先，其次 secrets/ 文件。两者都没有就返回空串，由调用方给出可读的缺凭证提示。
function readSecret(filename, envKey) {
  if (envKey && process.env[envKey]) return process.env[envKey].trim();
  try {
    return fs.readFileSync(path.join(SECRETS_DIR, filename), 'utf8').trim();
  } catch {
    return '';
  }
}

module.exports = { readSecret, SECRETS_DIR };
