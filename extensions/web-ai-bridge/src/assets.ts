import { readdir, readFile, stat } from 'node:fs/promises';
import { extname, join, basename } from 'node:path';
import { BridgeError } from './domain';

export async function listPrompts(directory: string): Promise<string[]> {
  try {
    return (await readdir(directory, { withFileTypes: true }))
      .filter((entry) => entry.isFile() && /\.md$/i.test(entry.name))
      .map((entry) => entry.name)
      .sort((a, b) => a.localeCompare(b, 'ja'));
  } catch {
    throw new BridgeError(
      'PROMPT_DIRECTORY',
      'プロンプトフォルダを読み取れません。設定を確認してください。',
    );
  }
}

export async function loadPrompt(
  directory: string,
  name: string,
): Promise<string> {
  if (!name) return '';
  if (basename(name) !== name || !(await listPrompts(directory)).includes(name))
    throw new BridgeError(
      'PROMPT_NOT_FOUND',
      'プロンプトを選び直してください。',
    );
  const path = join(directory, name);
  if ((await stat(path)).size > 1024 * 1024)
    throw new BridgeError(
      'PROMPT_TOO_LARGE',
      'プロンプトは 1 MB 以下にしてください。',
    );
  return (await readFile(path, 'utf8')).replace(/^\uFEFF/, '');
}

const imageTypes: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.bmp': 'image/bmp',
};
export async function attachmentView(path: string, name: string) {
  const type = imageTypes[extname(path).toLowerCase()];
  try {
    const info = await stat(path);
    if (!type) return { name, size: info.size };
    if (info.size > 8 * 1024 * 1024)
      return { name, size: info.size, note: '8 MB 超のためサムネイル省略' };
    return {
      name,
      size: info.size,
      thumbnail: `data:${type};base64,${(await readFile(path)).toString('base64')}`,
    };
  } catch {
    return { name, note: 'ファイルを読み取れません' };
  }
}
