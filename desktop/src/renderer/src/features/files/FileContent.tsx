import { formatBytes } from '../../../../shared/format';
import { Markdown } from '../chat/Markdown';
import type { FileContentDto } from '../../../../shared/contract';

const MARKDOWN_FILE = /\.(md|markdown)$/i;

/**
 * The text viewer. Binary and >1 MiB files are deliberately not previewed —
 * the daemon caps `content` at `MAX_CONTENT_BYTES` and flags both, so the client
 * shows size + path instead of a megabyte of mojibake.
 *
 * Markdown is rendered instead of shown as source, matching the mobile clients.
 */
export function FileContent({ file }: { file: FileContentDto }) {
  if (file.binary) {
    return <div className="fnotice">二进制文件，不预览。{formatBytes(file.size)}</div>;
  }
  if (file.content === '' && file.size > 0) {
    return <div className="fnotice">这个文件没有可显示的文本内容（{formatBytes(file.size)}）。</div>;
  }
  return (
    <>
      {file.truncated && (
        <div className="fnotice">文件超过 1 MiB，只显示前面部分（共 {formatBytes(file.size)}）。</div>
      )}
      {MARKDOWN_FILE.test(file.path) ? (
        <Markdown text={file.content} />
      ) : (
        <pre className="fcode">{file.content}</pre>
      )}
    </>
  );
}
