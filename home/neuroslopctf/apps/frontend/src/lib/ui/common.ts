import * as api from '../endpoints';
import type * as T from '../types';
import {ApiError,requireCurrentUser} from '../api';
import {h,section,form,action,link,secret,status,empty,errorState,href,type Field,confirmAction} from '../dom';
import {labels} from '../permissions';
import {badge} from '../dom';
import {formatDate,localDateInput} from '../format';
export {h,section,form,action,link,secret,status,empty,errorState,href,confirmAction};
export const params=()=>new URLSearchParams(location.search);
export const go=(path:string,q:Record<string,string|number|undefined>={})=>location.assign(href(path,q));
export const sval=(d:Record<string,string|boolean>,k:string)=>String(d[k]??'');
export const nval=(d:Record<string,string|boolean>,k:string)=>Number(d[k])||null;
export const reload=()=>location.reload();
export const field=(name:string,label:string,type='text',value?:Field['value'],options?:Field['options']):Field=>({name,label,type,value,options});
export const select=(name:string,label:string,options:Field['options'],value?:Field['value']):Field=>({name,label,options,value});
export async function region(root:HTMLElement,render:()=>Promise<void>){
 root.setAttribute('aria-busy','true');root.replaceChildren(status('Загружаем данные через API…'));
 try{await render();}catch(e){root.replaceChildren(errorState(e,()=>void region(root,render)));}finally{root.removeAttribute('aria-busy');}
}
export async function requireUser(){const u=await requireCurrentUser();if(!u)throw new ApiError(401,'Перенаправляем на вход');return u;}
export const competitionFields=(c?:T.Competition,owner=true):Field[]=>[
 {name:'title',label:'Название соревнования',required:true,minlength:3,maxlength:120,value:c?.title},
 {name:'description',label:'Описание соревнования',type:'textarea',maxlength:20000,value:c?.description},
 {...select('visibility','Видимость',['public','unlisted','private'],c?.visibility??'public'),disabled:!owner},
 {...select('join_policy','Порядок вступления',['open','invite','approval'],c?.join_policy??'open'),disabled:!owner},
 {name:'starts_at',label:'Начало',type:'datetime-local',required:true,value:localDateInput(c?.starts_at??new Date(Date.now()+3600000).toISOString())},
 {name:'freeze_at',label:'Заморозка рейтинга',type:'datetime-local',value:localDateInput(c?.freeze_at)},
 {name:'ends_at',label:'Окончание',type:'datetime-local',required:true,value:localDateInput(c?.ends_at??new Date(Date.now()+86400000).toISOString())},
 field('team_mode','Командный режим','checkbox',c?.team_mode??false),
 {name:'team_size_max',label:'Максимум участников команды',type:'number',min:1,max:20,value:c?.team_size_max??5,required:true},
 select('scoring','Подсчёт очков',['static','dynamic'],c?.scoring??'static')
];
export function competitionBody(d:Record<string,string|boolean>):T.CompetitionCreate{
 const start=new Date(sval(d,'starts_at')),end=new Date(sval(d,'ends_at')),freeze=d.freeze_at?new Date(sval(d,'freeze_at')):null;
 if(!(start<end)||freeze&&!(start<freeze&&freeze<end))throw new Error('Проверьте порядок дат: начало → заморозка → окончание');
 return {...d,starts_at:start.toISOString(),ends_at:end.toISOString(),freeze_at:freeze?.toISOString()??null,team_size_max:Number(d.team_size_max)} as unknown as T.CompetitionCreate;
}
export function competitionCard(c:T.CompetitionSummary,pin?:Node|null){
 const open=link('Открыть соревнование','/c',{c:c.slug});open.className='btn-secondary btn-small';
 return h('article',{class:'task-card competition-card card'},
  h('div',{class:'task-card-head'},h('div',{class:'task-badges'},badge(c.state),badge(c.visibility),badge(c.join_policy)),pin??null),
  h('div',{class:'task-card-body'},h('h2',{class:'task-title'},c.title),
   h('p',{class:'task-card-description'},formatDate(c.starts_at)+' — '+formatDate(c.ends_at)),
   h('div',{class:'task-card-meta'},h('span',{},'Количество участников: '+c.participants),h('span',{},c.team_mode?'Командный режим':'Личный зачёт'))),
  h('div',{class:'task-card-footer'},h('span',{class:'task-card-author'},c.viewer?.role?'Ваша роль: '+labels[c.viewer.role]:c.owner.username),open));
}
export function solveCard(r:T.SolveRecord){return h('article',{class:'profile-list-item'},
 h('h3',{class:'profile-list-title'},r.task.title),
 h('div',{class:'profile-list-meta'},h('span',{},r.points_awarded+' очков'),h('span',{},formatDate(r.solved_at))),
 h('div',{class:'inline-actions'},link(r.competition.title,'/c',{c:r.competition.slug}),link('Открыть задание','/c/task',{c:r.competition.slug,t:r.task.slug})),secret(r.reward_token,'Токен решения'));}
export function table(headers:string[],rows:Node[][]){return h('div',{class:'table-scroll'},h('table',{},h('thead',{},h('tr',{},...headers.map(s=>h('th',{scope:'col'},s)))),h('tbody',{},...rows.map(cells=>h('tr',{},...cells.map(cell=>h('td',{},cell)))))));}
export async function paged<R>(root:HTMLElement,fetcher:(offset:number)=>Promise<T.Paginated<R>>,render:(r:R)=>Node,_limit=24){
 let offset=0;const list=h('div',{class:'v2-list'});root.append(list);
 const more=action('Показать ещё',async()=>{await load();});root.append(more);
 async function load(){const result=await fetcher(offset);if(offset===0&&!result.items.length)list.append(empty());list.append(...result.items.map(render));offset+=result.items.length;more.hidden=offset>=result.total;more.disabled=result.items.length===0;more.setAttribute('aria-label','Показать ещё, загружено '+offset+' из '+result.total);}
 await load();
}
export function filters(fields:Field[],base:Record<string,string|number|undefined>={}){
 const toolbar=form(fields,'Применить фильтры',async d=>go(location.pathname,{...base,...Object.fromEntries(Object.entries(d).map(([k,v])=>[k,String(v)]))}));
 toolbar.classList.add('toolbar','card','catalog-toolbar');return toolbar;
}
export async function submissions(root:HTMLElement,c:string,task?:string){
 const q=params();root.append(filters([field('task','Задание','text',task??q.get('task')),field('user','ID участника','number',q.get('user')),field('team','ID команды','number',q.get('team')),select('correct','Результат',[{value:'',label:'Все'},{value:'true',label:'Верно'},{value:'false',label:'Неверно'}],q.get('correct'))],{c,tab:'submissions',t:params().get('t')??undefined}));
 await paged(root,offset=>api.listSubmissions(c,{task:task??q.get('task'),user:q.get('user'),team:q.get('team'),correct:q.get('correct'),limit:50,offset}),r=>section('Отправка № '+r.id,h('p',{},'Задание #'+r.task_id+' · участник #'+r.user_id+' · '+(r.correct?'Верно':'Неверно')+' · '+formatDate(r.created_at)),r.value!==undefined?secret(r.value,'Отправленный флаг'):null),50);
}
export const timezone=()=>h('p',{class:'field-hint'},'Даты вводятся в вашем часовом поясе: '+Intl.DateTimeFormat().resolvedOptions().timeZone+'. На сервер отправляется UTC.');
