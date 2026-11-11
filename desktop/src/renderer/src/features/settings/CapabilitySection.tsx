import { useEffect, useState } from 'react';
import { api } from '../../ipc/client';
import type { CapabilityCatalogDto } from '../../../../shared/contract';

/** Global capability catalog: ends select from this list; nothing is enabled here. */
export function CapabilitySection() {
  const [items, setItems] = useState<CapabilityCatalogDto[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void api.capabilities().then((res) => {
      if (res.ok) setItems(res.data.capabilities);
      else setError('无法加载能力列表');
    });
  }, []);

  return (
    <div className="settings-section">
      <div className="section-head"><h3>能力</h3></div>
      <p className="hint">
        能力是全局可用的工具面；在某个端里勾选后，该端才启用对应能力。这里只展示目录与适用范围。
      </p>
      {error && <p className="mem-error">{error}</p>}
      {items.map((item) => (
        <div className="device-suggestion" key={item.id}>
          <div>
            <div><b>{item.name}</b> <span className="hint mono">{item.id}</span></div>
            <div className="hint">
              {item.domains.length > 0 ? `适用端：${item.domains.join(' / ')}` : '工作区级能力'}
              {item.tools.length > 0 ? ` · ${item.tools.length} 个工具` : ''}
              {item.approval === 'server-gate' ? ' · 需审批' : ''}
            </div>
          </div>
        </div>
      ))}
    </div>
  );
}
