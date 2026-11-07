import { useEffect, useState } from "react";
import { api } from "../api";
type Status = { state: string; qrDataUrl?: string; contactsReady?: boolean; blockedCount?: number; attention?: number; enabled?: boolean };
type Paused = { id: string; name?: string; username?: string; channel: string; whatsappSavedContact: boolean; personal: boolean };
const names: Record<string,string> = { not_configured: "Подключение готовится", disconnected: "Не подключён", pairing: "Отсканируйте QR-код", synchronizing: "Проверяем контакты", ready: "Подключён", paused: "Ответы на паузе", unavailable: "Нет связи", starting: "Подключаем", qr: "Отсканируйте QR-код" };
export function WhatsAppSettings() {
  const [status,setStatus] = useState<Status>({state:"disconnected"});
  const [paused,setPaused] = useState<Paused[]>([]);
  const [error,setError] = useState("");
  const [busy,setBusy] = useState(false);
  async function refresh() {
    try { const [s,p] = await Promise.all([api<Status>("/admin/v1/whatsapp/status"),api<Paused[]>("/admin/v1/conversations/paused")]); setStatus(s);setPaused(p);setError(""); }
    catch(e) { setError(e instanceof Error?e.message:"Не удалось проверить подключение"); }
  }
  useEffect(()=>{void refresh();const t=setInterval(()=>void refresh(),5000);return()=>clearInterval(t);},[]);
  async function action(path:string) {
    setBusy(true);setError("");
    try {await api(path,{method:"POST",body:{}});await refresh();} catch(e){setError(e instanceof Error?e.message:"Ошибка подключения");} finally{setBusy(false);}
  }
  return <section aria-labelledby="wa-title" style={{marginBlock:24,paddingBlock:16,borderBlock:"1px solid #ddd"}}>
    <h3 id="wa-title">WhatsApp</h3>
    <p>Только ответы на новые личные обращения. Всем сохранённым контактам помощник не отвечает.</p>
    <p role="status"><strong>{names[status.state]||"Проверяем подключение"}</strong>{status.contactsReady?` · Контактов в списке запретов: ${status.blockedCount??0}`:" · Ждём проверки контактов"}</p>
    {status.qrDataUrl?.startsWith("data:image/")&&<><img src={status.qrDataUrl} alt="QR-код подключения WhatsApp" style={{width:264,maxWidth:"100%"}}/><p>На телефоне: WhatsApp → Связанные устройства → Привязка устройства.</p></>}
    <div style={{display:"flex",gap:8,flexWrap:"wrap"}}>{([['start','Подключить по QR'],['resume','Включить ответы'],['pause','Пауза'],['logout','Отключить устройство']] as const).map(([a,label])=><button key={a} type="button" className="btn" disabled={busy||status.state==="not_configured"||(a==="resume"&&!status.contactsReady)} onClick={()=>void action(`/admin/v1/whatsapp/${a}`)}>{label}</button>)}</div>
    {!!status.attention&&<p className="msg err">Требуют проверки обращения: {status.attention}. Откройте журнал и ответьте вручную.</p>}
    {error&&<p role="alert" className="msg err">{error}</p>}
    <p className="hint">Ваш ручной ответ останавливает помощника в этом чате. Исключение — ссылка после проверки оплаты. Контактам из списка запретов не отправляется и она.</p>
    {!!paused.length&&<details><summary>После ручного ответа ({paused.length})</summary>{paused.map(c=><div key={c.id} style={{display:"flex",gap:12,flexWrap:"wrap",marginBlock:10}}><span>{c.name||c.username||"Клиент"} · {c.channel}</span><button type="button" disabled={busy||c.personal||c.whatsappSavedContact} onClick={()=>void action(`/admin/v1/conversations/${encodeURIComponent(c.id)}/resume`)}>Вернуть помощника</button><button type="button" disabled={busy||c.personal} onClick={()=>void action(`/admin/v1/conversations/${encodeURIComponent(c.id)}/block`)}>Не отвечать</button></div>)}</details>}
  </section>;
}
