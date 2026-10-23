export function formatDate(value:string|null|undefined, options:Intl.DateTimeFormatOptions = {}):string {
 if (!value || !Number.isFinite(Date.parse(value))) return '—';
 return new Intl.DateTimeFormat('ru-RU',{dateStyle:'medium',timeStyle:'short',...options}).format(new Date(value));
}
export function formatRemaining(value:string):string {
 const s = Math.max(0,Math.ceil((Date.parse(value)-Date.now())/1000));
 return Number.isFinite(s) ? Math.floor(s/86400)+' д. '+Math.floor(s%86400/3600)+' ч. '+Math.floor(s%3600/60)+' мин. '+s%60+' с.' : '—';
}
export const formatSize = (n:number) => n < 1024 ? n+' Б' : n < 1048576 ? (n/1024).toFixed(1)+' КБ' : (n/1048576).toFixed(1)+' МБ';
export const localDateInput = (v?:string|null) => v ? new Date(Date.parse(v)-new Date(v).getTimezoneOffset()*60000).toISOString().slice(0,16) : '';
