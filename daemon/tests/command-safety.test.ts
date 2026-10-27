import { describe, expect, it } from 'vitest';
import { isReadOnlyBash } from '../src/permissions/command-safety';

describe('isReadOnlyBash', () => {
  it('放行明确只读的命令', () => {
    expect(isReadOnlyBash('ls -la /tmp')).toBe(true);
    expect(isReadOnlyBash('cat file.txt')).toBe(true);
    expect(isReadOnlyBash('head -20 log.txt')).toBe(true);
    expect(isReadOnlyBash('grep -r foo src')).toBe(true);
    expect(isReadOnlyBash('node --version')).toBe(true);
    expect(isReadOnlyBash('python3 --version')).toBe(true);
    expect(isReadOnlyBash('git status')).toBe(true);
    expect(isReadOnlyBash('git log --oneline')).toBe(true);
    expect(isReadOnlyBash('pwd')).toBe(true);
    expect(isReadOnlyBash('du -sh .')).toBe(true);
  });

  it('拦截写入/删除/有副作用的命令', () => {
    expect(isReadOnlyBash('rm -rf /tmp/x')).toBe(false);
    expect(isReadOnlyBash('mkdir foo')).toBe(false);
    expect(isReadOnlyBash('touch a.txt')).toBe(false);
    expect(isReadOnlyBash('mv a b')).toBe(false);
    expect(isReadOnlyBash('cp a b')).toBe(false);
    expect(isReadOnlyBash('git commit -m x')).toBe(false);
    expect(isReadOnlyBash('git push')).toBe(false);
    expect(isReadOnlyBash('npm install')).toBe(false);
    expect(isReadOnlyBash('node server.js')).toBe(false);
    expect(isReadOnlyBash('find . -delete')).toBe(false);
  });

  it('拦截含 shell 元字符的组合命令', () => {
    expect(isReadOnlyBash('ls > out.txt')).toBe(false);
    expect(isReadOnlyBash('cat a | grep b')).toBe(false);
    expect(isReadOnlyBash('ls && rm -rf /')).toBe(false);
    expect(isReadOnlyBash('echo $(cat /etc/passwd)')).toBe(false);
    expect(isReadOnlyBash('grep x `which sh`')).toBe(false);
  });
});
