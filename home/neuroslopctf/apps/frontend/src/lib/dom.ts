import {ApiError, copyText, detailToMessage, errorMessage} from './api';
import {labels} from './permissions';
import {formCaptions, sectionCaptions, type InterfaceCaption} from '../data/interface-copy';
import {resolveCaption} from './interface-copy';
export type Child = Node|string|number|null|undefined|false;
export function h<K extends keyof HTMLElementTagNameMap>(tag:K, attrs:Record<string,unknown> = {}, ...children:Child[]):HTMLElementTagNameMap[K] {
 const node = document.createElement(tag);
 for (const [key,value] of Object.entries(attrs)) {
  if(value === undefined || value === null || value === false) continue;
  if(key.startsWith('on') && typeof value === 'function') node.addEventListener(key.slice(2).toLowerCase(),value as EventListener);
  else if(key === 'class') node.className=String(value);
  else if(key === 'value' && 'value' in node) (node as HTMLInputElement).value=String(value);
  else if(key === 'checked' && node instanceof HTMLInputElement) node.checked=Boolean(value);
  else node.setAttribute(key,value === true ? '' : String(value));
 }
 for(const child of children) if(child !== null && child !== undefined && child !== false) node.append(child instanceof Node?child:String(child));
 return node;
}
export function setText(node:Element,value:unknown) {node.textContent=String(value ?? '');}
export const href = (path:string, q:Record<string,string|number|undefined>={}) => {
 const p=new URLSearchParams(); Object.entries(q).forEach(([k,v])=>{if(v!==undefined)p.set(k,String(v));});
 if(!path.startsWith('/')||path.startsWith('//')||path.includes('\\')) throw Error('Недопустимая ссылка');
 return path+(p.size?'?'+p:'');
};
export const link = (text:string,path:string,q?:Record<string,string|number|undefined>) => h('a',{href:href(path,q),class:'btn-ghost btn-small'},text);
export const badge = (value:string) => h('span',{class:'state-badge'},labels[value]??value);
export function interfaceCaption(copy:InterfaceCaption) {
 copy=resolveCaption(copy);
 return h('p',{class:'interface-caption'},h('span',{},copy.text),copy.stack?h('small',{class:'interface-stack'},copy.stack):null);
}
export function section(title:string,...children:Child[]) {
 const caption=Object.hasOwn(sectionCaptions,title)?sectionCaptions[title]:undefined;
 return h('section',{class:'card section-card v2-section'},h('div',{class:'eyebrow'},'Раздел'),h('h2',{},title),caption?interfaceCaption(caption):null,...children);
}
export const empty = () => h('div',{class:'empty-state'},h('h3',{},'Пока ничего нет'),h('p',{},'Нет записей для отображения.'));
export function status(message:string,kind='') {return h('p',{class:'status-message '+kind,role:'status','aria-live':'polite'},message);}
export function errorState(error:unknown,retry?:()=>void) {
 const code=error instanceof ApiError?error.status:0;
 return section(code===404?'Не найдено или нет доступа':code===403?'Доступ запрещён':'Не удалось загрузить',
  status(errorMessage(error),'error'),retry?action('Повторить загрузку',retry):null,link('К соревнованиям','/competitions'));
}
export function action(text:string,run:()=>unknown|Promise<unknown>,style='btn-ghost') {
 const b=h('button',{type:'button',class:style},text);
 b.addEventListener('click',async()=>{
  if(b.disabled)return; b.disabled=true; b.setAttribute('aria-busy','true');
  const message=status('Выполняем действие…'); b.after(message);
  try {await run(); message.remove();} catch(e){message.replaceWith(status(errorMessage(e),'error'));} finally{b.disabled=false;b.removeAttribute('aria-busy');}
 }); return b;
}
export function secret(value:string,label='Секрет') {
 const output=h('code',{'data-secret-value':true},'••••');
 const reveal=action('Показать '+label,()=>{const shown=output.textContent==='••••';output.textContent=shown?value:'••••';reveal.textContent=(shown?'Скрыть ':'Показать ')+label;});
 return h('div',{class:'secret-field'},h('span',{class:'micro-label'},label),output,reveal,action('Копировать '+label,async()=>{await copyText(value);}));
}
export function confirmAction(title:string,typed?:string):Promise<boolean> {
 return new Promise(resolve=>{
  const d=h('dialog',{class:'card confirm-dialog','aria-label':title});
  const input=typed?h('input',{class:'text-input','aria-label':'Введите идентификатор',placeholder:typed}):null;
  const yes=h('button',{type:'button',class:'btn-primary'},'Подтвердить');
  const no=h('button',{type:'button',class:'btn-ghost'},'Отмена');
  d.append(h('h2',{},title),h('p',{class:'field-hint'},typed?'Для подтверждения введите: '+typed:'Нажмите «Подтвердить», чтобы выполнить действие.'),...(input?[input]:[]),yes,no);
  let result=false;
  yes.onclick=()=>{if(input&&input.value!==typed){input.setCustomValidity('Идентификатор не совпадает');input.reportValidity();return;}result=true;d.close();};
  input?.addEventListener('input',()=>input.setCustomValidity(''));
  no.onclick=()=>d.close();
  d.addEventListener('close',()=>{d.remove();resolve(result);},{once:true});
  document.body.append(d);d.showModal();
 });
}
export function showTokenOnce(value:string):Promise<void> {
 return new Promise(resolve=>{
  const d=h('dialog',{class:'card confirm-dialog','aria-label':'Новый API-токен'});
  d.append(h('h2',{},'Скопируйте токен сейчас'),h('p',{},'После закрытия этого окна токен больше не будет показан.'),secret(value,'API-токен'),action('Закрыть',()=>d.close()));
  d.addEventListener('close',()=>{value='';d.replaceChildren();d.remove();resolve();},{once:true});
  document.body.append(d);d.showModal();
 });
}
export interface Field {name:string;label:string;type?:string;value?:string|number|boolean|null;options?:readonly string[]|{value:string;label:string}[];required?:boolean;min?:number;max?:number;minlength?:number;maxlength?:number;disabled?:boolean}
let fieldId=0;
export function form(fields:Field[],submitLabel:string,submit:(data:Record<string,string|boolean>,form:HTMLFormElement)=>Promise<unknown>) {
 const f=h('form',{class:'form-grid','aria-label':submitLabel});
 for(const field of fields){
  const id='field-'+(++fieldId);
  const attrs={id,name:field.name,class:'text-input',required:field.required,disabled:field.disabled,min:field.min,max:field.max,minlength:field.minlength,maxlength:field.maxlength};
  const input=field.options?h('select',attrs,...field.options.map(o=>{const v=typeof o==='string'?o:o.value;return h('option',{value:v,selected:String(field.value)===v},typeof o==='string'?labels[o]??o:o.label);})):
   field.type==='textarea'?h('textarea',{...attrs,rows:4},String(field.value??'')):
   h('input',{...attrs,type:field.type??'text',...(field.type==='checkbox'?{checked:field.value}:{value:field.value??''}),autocomplete:field.type==='password'?'off':undefined});
  let control:HTMLElement=input;
  if(field.type==='file'&&input instanceof HTMLInputElement){
   const filename=h('span',{class:'file-picker-name'},'Файл не выбран');
   control=h('div',{class:'file-picker'},h('span',{class:'btn-ghost btn-small'},'Выбрать файл'),filename,input);
   input.addEventListener('change',()=>{filename.textContent=input.files?.[0]?.name??'Файл не выбран';});
  }
  const row=h('div',{class:'form-field'},h('label',{for:id,class:'field-label'},field.label),control,h('span',{'data-field-error':field.name,class:'field-error',role:'alert'}));
  if(field.type==='password')row.append(action('Показать '+field.label,()=>{const p=input as HTMLInputElement;p.type=p.type==='password'?'text':'password';}));
  if(field.type==='textarea'||field.name==='title'||field.type==='checkbox')row.classList.add('full');
  f.append(row);
 }
 const message=status(''); const button=h('button',{class:'btn-primary',type:'submit'},submitLabel);
 f.append(message,button);
 if(formCaptions[submitLabel])f.append(interfaceCaption(formCaptions[submitLabel]));
 f.onsubmit=async e=>{
  e.preventDefault(); if(f.getAttribute('aria-busy')==='true'||!f.reportValidity())return;
  f.querySelectorAll('[data-field-error]').forEach(n=>setText(n,''));
  const data:Record<string,string|boolean>={};
  fields.forEach(field=>{if(field.disabled)return;const input=f.elements.namedItem(field.name) as HTMLInputElement; data[field.name]=field.type==='checkbox'?input.checked:input.value;});
  f.setAttribute('aria-busy','true');button.disabled=true;setText(message,'Отправляем данные формы…');
  try{await submit(data,f);setText(message,'Действие выполнено.');}
  catch(e){
   setText(message,errorMessage(e));
   if(e instanceof ApiError&&Array.isArray(e.detail)) for(const detail of e.detail){
    const name=String(detail.loc?.at(-1)??'');
    for(const node of f.querySelectorAll<HTMLElement>('[data-field-error]')) if(node.dataset.fieldError===name)setText(node,detailToMessage([detail]));
   }
  }finally{f.removeAttribute('aria-busy');button.disabled=false;}
 };
 return f;
}
export function tabs(items:{label:string;path:string;q?:Record<string,string|number|undefined>;active?:boolean}[]) {
 const nav=h('nav',{class:'v2-tabs','aria-label':'Разделы страницы'},...items.map(i=>{const a=link(i.label,i.path,i.q);if(i.active)a.setAttribute('aria-current','page');return a;}));
 nav.addEventListener('keydown',e=>{if(!['ArrowLeft','ArrowRight','Home','End'].includes(e.key))return;const links=[...nav.querySelectorAll('a')];const index=links.indexOf(document.activeElement as HTMLAnchorElement); const next=e.key==='Home'?0:e.key==='End'?links.length-1:(index+(e.key==='ArrowRight'?1:-1)+links.length)%links.length;links[next]?.focus();e.preventDefault();});
 return nav;
}
export function poll(run:()=>Promise<unknown>,ms:number,enabled:()=>boolean=()=>true) {
 let timer:ReturnType<typeof setTimeout>|undefined; let stopped=false;
 const schedule=()=>{clearTimeout(timer);if(!stopped&&document.visibilityState==='visible'&&enabled())timer=setTimeout(async()=>{try{await run();}catch{ }schedule();},ms);};
 const stop=()=>{stopped=true;clearTimeout(timer);document.removeEventListener('visibilitychange',schedule);};
 document.addEventListener('visibilitychange',schedule);window.addEventListener('pagehide',stop,{once:true});schedule();return stop;
}
