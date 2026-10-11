import { readdir, readFile, mkdir, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { format, resolveConfig } from 'prettier';

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

export async function createExtension(name, root = repositoryRoot) {
  if (!/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/.test(name ?? '') || name.length > 64) {
    throw new Error(
      '名前は小文字英字で始まる英数字・ハイフン、64文字以内で指定してください。',
    );
  }
  if (/^(con|prn|aux|nul|com[0-9]|lpt[0-9])$/.test(name)) {
    throw new Error('Windows の予約名は使用できません。');
  }
  const target = join(root, 'extensions', name);
  const template = join(root, 'templates', 'extension');
  const files = await readdir(template, {
    recursive: true,
    withFileTypes: true,
  });
  await mkdir(join(root, 'extensions'), { recursive: true });
  // recursive を使わず、既存プロジェクトの上書きを拒否する。
  await mkdir(target);
  for (const file of files) {
    if (!file.isFile()) continue;
    const source = join(file.parentPath, file.name);
    const relative = source
      .slice(template.length + 1)
      .replace(/\.template$/, '');
    const destination = join(target, relative);
    await mkdir(dirname(destination), { recursive: true });
    let content = (await readFile(source, 'utf8')).replaceAll('__NAME__', name);
    if (/\.(json|ts|md)$/.test(destination)) {
      content = await format(content, {
        ...(await resolveConfig(join(root, '.prettierrc.json'))),
        filepath: destination,
      });
    }
    await writeFile(destination, content, { encoding: 'utf8', flag: 'wx' });
  }
  return target;
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  try {
    const target = await createExtension(process.argv[2]);
    console.log(
      `作成しました: ${target}\n次にルートで npm install を実行してください。`,
    );
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
