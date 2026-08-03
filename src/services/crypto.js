/**
 * crypto.js — AES-256-GCM 加密服务
 *
 * - 主密钥：APP_SECRET_KEY（任意长度字符串）经 SHA-256 派生 32 字节
 * - 每次加密生成随机 12B IV；认证标签 16B
 * - 输出单字段：base64(iv(12) ‖ tag(16) ‖ ciphertext)
 * - AAD 绑定通道标识（telegram / smtp / totp），防密文跨表替换
 * - 密钥/密文禁止输出到日志
 */

import crypto from 'node:crypto';
import config from '../config.js';

const IV_LEN = 12;
const TAG_LEN = 16;

let _key = null;

function masterKey() {
  if (_key) return _key;
  _key = crypto.createHash('sha256').update(config.appSecretKey, 'utf8').digest();
  return _key;
}

/**
 * 加密
 * @param {string} plain 明文（UTF-8）
 * @param {string} aad 关联数据（通道标识）
 * @returns {string} base64(iv‖tag‖ct)
 */
export function encrypt(plain, aad) {
  const iv = crypto.randomBytes(IV_LEN);
  const cipher = crypto.createCipheriv('aes-256-gcm', masterKey(), iv);
  cipher.setAAD(Buffer.from(aad, 'utf8'));
  const ct = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, ct]).toString('base64');
}

/**
 * 解密
 * @param {string} payload base64(iv‖tag‖ct)
 * @param {string} aad 关联数据（须与加密时一致）
 * @returns {string} 明文
 * @throws 密文损坏 / AAD 不匹配 / 密钥不匹配
 */
export function decrypt(payload, aad) {
  const raw = Buffer.from(payload, 'base64');
  if (raw.length < IV_LEN + TAG_LEN + 1) {
    throw new Error('密文格式非法');
  }
  const iv = raw.subarray(0, IV_LEN);
  const tag = raw.subarray(IV_LEN, IV_LEN + TAG_LEN);
  const ct = raw.subarray(IV_LEN + TAG_LEN);
  const decipher = crypto.createDecipheriv('aes-256-gcm', masterKey(), iv);
  decipher.setAAD(Buffer.from(aad, 'utf8'));
  decipher.setAuthTag(tag);
  const plain = Buffer.concat([decipher.update(ct), decipher.final()]);
  return plain.toString('utf8');
}
