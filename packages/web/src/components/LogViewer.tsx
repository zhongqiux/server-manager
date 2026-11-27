import { useEffect, useMemo, useRef, useState } from 'react';
import { Button, Input, Space, Switch, Tag, Typography } from 'antd';
import { DownloadOutlined } from '@ant-design/icons';
import Convert from 'ansi-to-html';
import type { JobDTO, JobLogStreamEvent } from '@sm/shared';
import { apiGet } from '../api/client';

const MAX_TEXT = 600_000;
const MAX_LINES = 2000;
const CHUNK_BYTES = 512 * 1024;
const ERROR_RE = /(error|exception|traceback|failed|fatal|错误|异常|失败)/i;

type ConnState = 'connecting' | 'live' | 'ended' | 'error';

const CONN_META: Record<ConnState, { color: string; label: string }> = {
  connecting: { color: 'processing', label: '连接中' },
  live: { color: 'success', label: '实时' },
  ended: { color: 'default', label: '已结束' },
  error: { color: 'error', label: '连接中断' },
};

function decodeBase64(data: string): Uint8Array {
  const binary = atob(data);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function stripCarriageReturns(text: string): string {
  return text
    .split('\n')
    .map((line) => {
      const index = line.lastIndexOf('\r');
      return index >= 0 ? line.slice(index + 1) : line;
    })
    .join('\n');
}

export default function LogViewer({ job, height = 440 }: { job: JobDTO; height?: number | string }) {
  const [conn, setConn] = useState<ConnState>('connecting');
  const [version, setVersion] = useState(0);
  const [follow, setFollow] = useState(true);
  const [onlyErrors, setOnlyErrors] = useState(false);
  const [keyword, setKeyword] = useState('');
  const [bufferStart, setBufferStart] = useState(0);
  const [loadingOlder, setLoadingOlder] = useState(false);

  const textRef = useRef('');
  const startRef = useRef(0);
  const truncatedRef = useRef(false);
  const dirtyRef = useRef(false);
  const decoderRef = useRef(new TextDecoder());
  const scrollerRef = useRef<HTMLDivElement>(null);

  const converter = useMemo(
    () =>
      new Convert({
        fg: '#e2e8f0',
        bg: '#0f172a',
        newline: false,
        escapeXML: true,
        stream: false,
      }),
    [],
  );

  const markDirty = (): void => {
    dirtyRef.current = true;
  };

  useEffect(() => {
    const timer = setInterval(() => {
      if (dirtyRef.current) {
        dirtyRef.current = false;
        setVersion((value) => value + 1);
      }
    }, 120);
    return () => clearInterval(timer);
  }, []);

  useEffect(() => {
    textRef.current = '';
    startRef.current = 0;
    truncatedRef.current = false;
    decoderRef.current = new TextDecoder();
    setBufferStart(0);
    setConn('connecting');
    setVersion((value) => value + 1);

    const source = new EventSource(`/api/jobs/${job.id}/logs/stream`);
    source.onopen = () => setConn('live');
    source.onmessage = (message) => {
      let event: JobLogStreamEvent;
      try {
        event = JSON.parse(message.data) as JobLogStreamEvent;
      } catch {
        return;
      }
      if (event.type === 'waiting') {
        setConn('live');
        return;
      }
      if (event.type === 'snapshot' || event.type === 'reset') {
        decoderRef.current = new TextDecoder();
        textRef.current = decoderRef.current.decode(decodeBase64(event.data));
        startRef.current = event.start;
        truncatedRef.current = false;
        setBufferStart(event.start);
        markDirty();
        return;
      }
      if (event.type === 'log') {
        const chunk = decoderRef.current.decode(decodeBase64(event.data), { stream: true });
        let text = textRef.current + chunk;
        if (text.length > MAX_TEXT) {
          text = text.slice(text.length - MAX_TEXT);
          truncatedRef.current = true;
        }
        textRef.current = text;
        markDirty();
        return;
      }
      if (event.type === 'gapped') {
        textRef.current += `\n[server-manager] 日志输出过快，已跳过部分字节（${event.from} ~ ${event.to}）\n`;
        markDirty();
        return;
      }
      if (event.type === 'end') {
        setConn(event.reason === 'error' ? 'error' : 'ended');
        source.close();
        markDirty();
      }
    };
    source.onerror = () => {
      setConn((current) => (current === 'ended' ? current : source.readyState === EventSource.CLOSED ? 'error' : 'connecting'));
    };
    return () => source.close();
  }, [job.id]);

  const html = useMemo(() => {
    void version;
    let lines = textRef.current.split('\n');
    if (lines.length > MAX_LINES) lines = lines.slice(-MAX_LINES);
    if (keyword.trim()) {
      const needle = keyword.trim().toLowerCase();
      lines = lines.filter((line) => line.toLowerCase().includes(needle));
    }
    if (onlyErrors) lines = lines.filter((line) => ERROR_RE.test(line));
    const plain = stripCarriageReturns(lines.join('\n'));
    if (!plain.trim()) {
      return '<span style="color:#64748b">等待日志输出…</span>';
    }
    return converter.toHtml(plain);
  }, [version, keyword, onlyErrors, converter]);

  useEffect(() => {
    if (!follow) return;
    const node = scrollerRef.current;
    if (node) node.scrollTop = node.scrollHeight;
  }, [html, follow]);

  const loadOlder = async (): Promise<void> => {
    if (startRef.current <= 0 || loadingOlder) return;
    setLoadingOlder(true);
    try {
      const result = await apiGet<{ start: number; end: number; size: number | null; data: string }>(
        `/api/jobs/${job.id}/logs/chunk?end=${startRef.current}&bytes=${CHUNK_BYTES}`,
      );
      if (result.data) {
        const prefix = new TextDecoder().decode(decodeBase64(result.data));
        textRef.current = prefix + textRef.current;
        startRef.current = result.start;
        setBufferStart(result.start);
        markDirty();
      } else {
        setBufferStart(0);
        startRef.current = 0;
      }
    } catch {
      // 加载失败时保持现状
    } finally {
      setLoadingOlder(false);
    }
  };

  const meta = CONN_META[conn];

  return (
    <div>
      <Space wrap size={10} style={{ marginBottom: 8 }}>
        <Tag color={meta.color} style={{ marginInlineEnd: 0 }}>
          {meta.label}
        </Tag>
        <Space size={4}>
          <Switch size="small" checked={follow} onChange={setFollow} />
          <Typography.Text style={{ fontSize: 12 }}>跟随最新</Typography.Text>
        </Space>
        <Space size={4}>
          <Switch size="small" checked={onlyErrors} onChange={setOnlyErrors} />
          <Typography.Text style={{ fontSize: 12 }}>只看错误</Typography.Text>
        </Space>
        <Input
          size="small"
          allowClear
          placeholder="过滤关键字"
          value={keyword}
          onChange={(event) => setKeyword(event.target.value)}
          style={{ width: 160 }}
        />
        <Button
          size="small"
          disabled={bufferStart <= 0 || truncatedRef.current}
          loading={loadingOlder}
          onClick={() => void loadOlder()}
        >
          加载更早
        </Button>
        <Button
          size="small"
          icon={<DownloadOutlined />}
          href={`/api/jobs/${job.id}/logs/download`}
          target="_blank"
        >
          下载日志
        </Button>
      </Space>
      <div
        className="sm-log"
        ref={scrollerRef}
        style={{ height }}
        onScroll={(event) => {
          const node = event.currentTarget;
          const atBottom = node.scrollHeight - node.scrollTop - node.clientHeight < 40;
          if (!atBottom && follow) setFollow(false);
        }}
      >
        <span dangerouslySetInnerHTML={{ __html: html }} />
      </div>
    </div>
  );
}