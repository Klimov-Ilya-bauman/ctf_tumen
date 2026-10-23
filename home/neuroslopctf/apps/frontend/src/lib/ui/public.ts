import * as api from '../endpoints';
import type * as T from '../types';
import {ApiError,getCurrentUser,errorMessage} from '../api';
import {can,tokenScopes} from '../permissions';
import {badge,tabs,poll,showTokenOnce} from '../dom';
import {formatDate,formatSize} from '../format';
import * as ui from './common';
import {facts,metric,taskCard} from './design';
const {h,section,form,action,link,secret,status,empty,confirmAction,params,go,sval,nval,reload,field,select,paged}=ui;
function paintStar(star:HTMLButtonElement,competitionId:number,pinOf:Map<number,number>){
 const label=pinOf.has(competitionId)?'Открепить соревнование':'Закрепить соревнование';
 star.setAttribute('aria-pressed',pinOf.has(competitionId)?'true':'false');
 star.setAttribute('aria-label',label);
 star.title=label;
 const glyph=star.firstElementChild;
 if(glyph)glyph.textContent=pinOf.has(competitionId)?'★':'☆';
}
function pinStar(competitionId:number,pinOf:Map<number,number>){
 const star=h('button',{type:'button',class:'pin-star','data-pin-cid':String(competitionId)},h('span',{'aria-hidden':'true'}));
 paintStar(star,competitionId,pinOf);
 star.addEventListener('click',async()=>{
  if(star.disabled)return;star.disabled=true;star.setAttribute('aria-busy','true');
  const pinId=pinOf.get(competitionId);
  try{
   if(pinId!==undefined){await api.deletePin(pinId);pinOf.delete(competitionId);}
   else{const created=await api.createPin(competitionId);pinOf.set(competitionId,created.id);}
   document.querySelectorAll<HTMLButtonElement>('.pin-star[data-pin-cid="'+competitionId+'"]')
     .forEach((s)=>paintStar(s,competitionId,pinOf));
  }catch(e){star.after(status(errorMessage(e),'error'));}
  finally{star.disabled=false;star.removeAttribute('aria-busy');}
 });
 return star;
}
const pinSummary=(c:T.Competition):T.CompetitionSummary=>({id:c.id,slug:c.slug,title:c.title,state:c.state,visibility:c.visibility,join_policy:c.join_policy,starts_at:c.starts_at,ends_at:c.ends_at,team_mode:c.team_mode,participants:c.stats.participants,owner:{id:c.owner_id,username:''},viewer:c.viewer?{role:c.viewer.role,status:c.viewer.status}:undefined});
function unavailablePin(p:T.Pin,pinOf:Map<number,number>){
 return h('article',{class:'task-card competition-card card'},
  h('div',{class:'task-card-head'},h('div',{class:'task-badges'},badge('недоступно')),pinStar(p.competition_id,pinOf)),
  h('div',{class:'task-card-body'},h('h2',{class:'task-title'},'Соревнование #'+p.competition_id),h('p',{class:'task-card-description'},'Сейчас недоступно для просмотра.')));
}
export async function catalog(root:HTMLElement){
 const q=params(),user=await getCurrentUser();
 root.append(tabs([['','Все'],['owned','Мои'],['joined','Я участник'],['staff','Я в команде организаторов']].map(([mine,label])=>({label,path:'/competitions',q:{mine},active:(q.get('mine')??'')===mine}))));
 root.append(ui.filters([field('q','Поиск','search',q.get('q')),select('state','Состояние',['','draft','scheduled','running','frozen','finished','archived'],q.get('state'))],{mine:q.get('mine')??undefined}),link('+ Создать соревнование','/competitions/new'));
 const pinOf=new Map<number,number>();
 if(user){
  const pins=(await api.listPins()).items;
  for(const p of pins)pinOf.set(p.competition_id,p.id);
  if(pins.length){
   const comps=await Promise.all(pins.map(p=>api.getCompetition(String(p.competition_id)).then(pinSummary,()=>null)));
   const cards=pins.map((p,i)=>{const s=comps[i];return s?ui.competitionCard(s,pinStar(s.id,pinOf)):unavailablePin(p,pinOf);});
   root.append(section('Закреплённые соревнования',h('div',{class:'task-board'},...cards)));
  }
 }
 await paged(root,offset=>api.listCompetitions({q:q.get('q'),state:q.get('state'),mine:q.get('mine'),limit:24,offset}),c=>ui.competitionCard(c,user?pinStar(c.id,pinOf):null));
}
export async function newCompetition(root:HTMLElement){
 await ui.requireUser();const panel=section('Создать соревнование',ui.timezone(),form(ui.competitionFields(),'Создать соревнование',async d=>{const c=await api.createCompetition(ui.competitionBody(d));go('/c/admin',{c:c.slug,tab:'settings'});}));panel.classList.add('editor-card');root.append(panel);
}
export async function overview(root:HTMLElement,c:T.Competition){
 const details=section(c.title,h('p',{class:'detail-description'},c.description),facts([
  ['Начало',formatDate(c.starts_at)],['Заморозка',formatDate(c.freeze_at)],['Окончание',formatDate(c.ends_at)],['Режим',c.team_mode?'Командный':'Личный зачёт']
 ]));details.classList.add('detail-card');
 const user=await getCurrentUser(),v=c.viewer;
 const join=section('Управление вашим участием');join.classList.add('solve-panel');
 root.append(h('div',{class:'stat-grid competition-stats'},metric('Участников',c.stats.participants),metric('Команд',c.stats.teams),metric('Заданий',c.stats.tasks_published),metric('Решений',c.stats.solves)),h('div',{class:'detail-layout'},details,join));
 if(!user)join.append(link('Войти для участия','/login',{next:location.pathname+location.search}));
 else if(v.status==='pending')join.append(status('Заявка на рассмотрении у организаторов.'));
 else if(v.status==='banned')join.append(status('Участие заблокировано. Доступны ваши обращения и история.'),link('Мои обращения','/c/tickets',{c:c.slug}));
 else if(v.status==='active'){join.append(badge(v.role??'participant'));if(!can(v.permissions,'competition.transfer'))join.append(action('Покинуть соревнование',async()=>{if(await confirmAction('Покинуть соревнование?')){await api.leaveCompetition(c.slug);reload();}}));}
 else if(!['scheduled','running','frozen'].includes(c.state))join.append(status('Вступление сейчас закрыто.'));
 else join.append(form(c.join_policy==='invite'?[{...field('invite_code','Код приглашения','password'),required:true}]:c.join_policy==='approval'?[{...field('message','Сообщение организаторам','textarea'),maxlength:1000}]:[],'Присоединиться',async d=>{await api.joinCompetition(c.slug,{...(d.invite_code?{invite_code:sval(d,'invite_code')}:{}),...(d.message?{message:sval(d,'message')}:{})});reload();}));
 const announcements=await api.listAnnouncements(c.slug);for(const a of announcements.items.filter(a=>a.pinned))root.append(section(a.title,h('p',{class:'plain-text'},a.body),badge('Закреплено')));
}
export async function tasks(root:HTMLElement,c:T.Competition,admin=false){
 const q=params();root.append(ui.filters([field('q','Поиск задания','search',q.get('q')),field('category','Категория','text',q.get('category')),select('difficulty','Сложность',['','easy','medium','hard'],q.get('difficulty')),...(admin?[select('state','Состояние',['','draft','review','published','hidden','archived'],q.get('state'))]:[])],{c:c.slug}));
 if(can(c.viewer.permissions,'tasks.create'))root.append(link('Создать задание','/c/admin/task-new',{c:c.slug}));
 const groups=new Map<string,HTMLElement>(),board=h('div',{class:'task-board'});
 let offset=0;
 const more=action('Показать ещё',load);root.append(board,more);
 async function load(){
  const result=await api.listTasks(c.slug,{q:q.get('q'),category:q.get('category'),difficulty:q.get('difficulty'),state:admin?q.get('state'):undefined,limit:24,offset});
  if(!offset&&!result.items.length)board.append(empty());
  for(const t of result.items){
   let group=groups.get(t.category);
   if(!group){group=h('div',{class:'task-grid'});groups.set(t.category,group);board.append(h('section',{class:'task-category'},h('div',{class:'section-head'},h('h2',{class:'section-title'},t.category)),group));}
   group.append(taskCard(c.slug,t));
  }
  offset+=result.items.length;more.hidden=offset>=result.total;more.disabled=!result.items.length;
  more.setAttribute('aria-label','Показать ещё, загружено '+offset+' из '+result.total);
 }
 await load();

}
export async function attachmentLink(c:string,a:T.Attachment){
 const anchor=link(a.filename+' · '+formatSize(a.size),api.downloadAttachment(c,a.id));

 return anchor;
}
export async function task(root:HTMLElement,c:T.Competition){
 const slug=params().get('t')??'',t=await api.getTask(c.slug,slug);
 const difficulty=badge(t.difficulty);difficulty.className='difficulty '+t.difficulty;
 const detail=h('article',{class:'detail-card card'},
  h('div',{class:'detail-head'},h('div',{},h('div',{class:'eyebrow'},t.category),h('h2',{class:'detail-title'},t.title)),h('div',{class:'task-badges'},difficulty,t.has_solved?h('span',{class:'solved-pill'},'Решено вами'):null)),
  facts([['Очки',t.points],['Решений',t.solve_count],['Открытие',formatDate(t.release_at)],['Максимум решений',t.max_solves??'Без ограничения']]),h('div',{class:'detail-description'},t.description));
 const content=h('div',{class:'detail-content'},detail);
 const solve=h('aside',{class:'solve-panel grid-shell','aria-label':'Отправка флага'},h('div',{class:'eyebrow'},'Решение задания'),h('h2',{},'Отправить флаг'));
 root.append(h('div',{class:'detail-layout'},content,solve));
 const files=section('Файлы задания');content.append(files);
 const attachments=await api.listAttachments(c.slug,slug);if(!attachments.items.length)files.append(empty());for(const a of attachments.items)files.append(await attachmentLink(c.slug,a));
 const hints=section('Подсказки к заданию');content.append(hints);
 for(const hint of (await api.listHints(c.slug,slug)).items){
  const panel=h('section',{class:'profile-list-item'},h('h3',{},'Подсказка № '+hint.order),h('p',{},'Стоимость: '+hint.cost+' очков'));
  if(hint.body!==undefined)panel.append(h('p',{class:'plain-text'},hint.body));
  else if(can(c.viewer.permissions,'play.unlock_hint'))panel.append(action('Открыть подсказку',async()=>{if(await confirmAction('Открыть подсказку за '+hint.cost+' очков?')){const result=await api.unlockHint(c.slug,hint.id);panel.replaceChildren(h('h3',{},'Подсказка № '+hint.order),h('p',{class:'plain-text'},result.body??''));}}));
  hints.append(panel);
 }
 if(!hints.querySelector('section'))hints.append(empty());
 if(t.closed)solve.append(status('Задание закрыто для новых решений.'));
 else if(!can(c.viewer.permissions,'play.submit'))solve.append(status('Отправка флага недоступна для вашей роли.'),link('Управление вашим участием','/c',{c:c.slug}));
 if(can(c.viewer.permissions,'play.submit')&&!t.closed){
  const result=h('div',{class:'token-result','aria-live':'polite'});result.hidden=true;
  solve.append(form([{name:'flag',label:'Флаг — ответ на задание',type:'password',required:true,maxlength:512}],'Отправить флаг',async(d,f)=>{
   try{
    const r=await api.submitFlag(c.slug,slug,sval(d,'flag'));result.hidden=false;result.replaceChildren(h('h2',{},r.correct?'Верный ответ':'Неверный ответ'),status(r.message,r.correct?'success':'error'));
    if(r.correct){result.append(secret(r.reward_token,'Токен решения'),h('p',{},r.points+' очков'+(r.already_solved?' · Это решение уже принято':'')));(f.elements.namedItem('flag') as HTMLInputElement).value='';await api.getTask(c.slug,slug);}
   }catch(e){
    if(e instanceof ApiError&&e.status===410){f.replaceChildren(status('Задание закрыто'));return;}
    if(e instanceof ApiError&&e.status===429){const end=Date.now()+(e.retryAfter||60)*1000;const cooldown=status('');f.after(cooldown);
     const lock=()=>{const seconds=Math.ceil((end-Date.now())/1000);f.querySelectorAll<HTMLInputElement|HTMLButtonElement>('input,button').forEach(b=>b.disabled=seconds>0);cooldown.textContent='Повторная отправка через '+Math.max(seconds,0)+' с.';if(seconds>0)setTimeout(lock,1000);else cooldown.remove();};setTimeout(lock,0);
    }throw e;
   }
  }),result);
 }
 if(can(c.viewer.permissions,'tickets.create'))solve.append(link('Задать вопрос по заданию','/c/tickets',{c:c.slug,task_slug:slug}));
 if(can(t.viewer_permissions,'task.view_secrets'))solve.append(link('Кабинет задания','/c/admin/task',{c:c.slug,t:slug}));
}
export async function scoreboard(root:HTMLElement,c:T.Competition){
 const user=await getCurrentUser();let page=Math.max(1,Math.floor(Number(params().get('page'))||1));
 const board=h('section',{class:'leaderboard-card card'});root.append(board);
 const load=async()=>{
  try{
   const r=await api.scoreboard(c.slug,{limit:50,offset:(page-1)*50});
   const head=h('div',{class:'panel-head'},h('div',{},h('div',{class:'eyebrow'},'Таблица результатов'),h('h2',{class:'panel-title'},c.title)),action('Обновить рейтинг',load,'btn-secondary btn-small'));
   board.replaceChildren(head,r.frozen?status('Рейтинг заморожен с '+formatDate(r.frozen_at)):status('Рейтинг показывает текущие результаты'));
   if(!r.items.length)board.append(empty());
   else {
    const table=ui.table(['Место','Участник / команда','Очки','Решено'],r.items.map(row=>[
     h('span',{class:'leaderboard-rank '+(row.rank<=3?'top':'')},row.rank),h('strong',{class:'table-user'},row.name),h('span',{class:'leaderboard-score table-number'},row.score),h('span',{class:'table-number'},row.solved)
    ]));
    table.classList.add('leaderboard-table-wrap');table.querySelector('table')!.classList.add('leaderboard-table');
    table.querySelectorAll('tbody tr').forEach((tr,i)=>{const row=r.items[i];if(row.user_id===user?.id||Boolean(row.team_id&&row.team_id===c.viewer.team_id)){tr.classList.add('is-me');tr.setAttribute('aria-label','Ваш результат');}});
    board.append(table);
   }
   const updatePage=async(next:number)=>{page=next;const url=new URL(location.href);url.searchParams.set('page',String(page));history.replaceState(null,'',url);await load();};
   const prev=action('Предыдущая страница',()=>updatePage(Math.max(1,page-1)),'btn-ghost btn-small');prev.disabled=page<=1;
   const next=action('Следующая страница',()=>updatePage(page+1),'btn-ghost btn-small');next.disabled=page*50>=r.total;
   board.append(h('div',{class:'pagination'},prev,h('span',{class:'field-hint'},'Страница '+page+' · Всего: '+r.total),next));
  }catch(e){board.replaceChildren(ui.errorState(e,()=>void load()));}
 };
 await load();poll(load,30000,()=>c.state==='running');
}
export async function teams(root:HTMLElement,c:T.Competition){
 const user=await ui.requireUser();const v=c.viewer;
 if(can(v.permissions,'play.submit')&&!v.team_id)root.append(form([{...field('name','Название команды'),required:true}],'Создать команду',async d=>{const team=await api.createTeam(c.slug,sval(d,'name'));go('/c/team',{c:c.slug,id:team.id});}));
 root.append(ui.filters([field('q','Поиск команды','search',params().get('q'))],{c:c.slug}));
 await paged(root,offset=>api.listTeams(c.slug,{q:params().get('q'),offset,limit:24}),team=>section(team.name,link('Открыть команду','/c/team',{c:c.slug,id:team.id}),h('p',{},'Капитан: #'+team.captain_id+(team.captain_id===user.id?' (вы)':''))));
}
export async function team(root:HTMLElement,c:T.Competition){
 const user=await ui.requireUser(),t=await api.getTeam(c.slug,Number(params().get('id')));
 root.append(section(t.name,h('p',{},'Капитан: #'+t.captain_id),t.join_code?secret(t.join_code,'Код команды'):null));
 const perms=t.viewer?.permissions??[];
 if(can(perms,'teams.manage')){
  root.append(form([field('name','Название команды','text',t.name),select('captain_id','Капитан',(t.members??[]).map(m=>({value:String(m.user_id),label:m.username})),t.captain_id)],'Сохранить команду',async d=>{await api.updateTeam(c.slug,t.id,{name:sval(d,'name'),captain_id:Number(d.captain_id)});reload();}),
   action('Перевыпустить код',async()=>{if(await confirmAction('Сменить код команды?')){await api.updateTeam(c.slug,t.id,{regenerate_code:true});reload();}}),
   action('Удалить команду',async()=>{if(await confirmAction('Удалить команду?')){await api.deleteTeam(c.slug,t.id);go('/c/teams',{c:c.slug});}}));
 }
 for(const member of t.members??[])root.append(section(member.username,link('Профиль участника','/u',{name:member.username}),can(perms,'teams.manage')||member.user_id===user.id?action(member.user_id===user.id?'Покинуть команду':'Исключить участника',async()=>{if(await confirmAction('Убрать участника из команды?')){await api.removeTeamMember(c.slug,t.id,member.user_id);reload();}}):null));
 if(can(c.viewer.permissions,'play.submit')&&!c.viewer.team_id)root.append(form([{...field('join_code','Код команды','password'),required:true}],'Вступить в команду',async d=>{await api.joinTeam(c.slug,t.id,sval(d,'join_code'));reload();}));
}
export async function announcements(root:HTMLElement,c:T.Competition){
 const r=await api.listAnnouncements(c.slug);if(!r.items.length)root.append(empty());
 for(const a of r.items)root.append(section(a.title,a.pinned?badge('Закреплено'):null,badge(a.audience),h('p',{class:'plain-text'},a.body),h('p',{},formatDate(a.created_at))));
}
export async function tickets(root:HTMLElement,c:T.Competition){
 await ui.requireUser();
 if(can(c.viewer.permissions,'tickets.create'))root.append(form([{...field('subject','Тема обращения'),required:true,maxlength:120},{...field('body','Текст обращения','textarea'),required:true,maxlength:8000},field('task_slug','Идентификатор задания','text',params().get('task_slug'))],'Создать обращение',async d=>{const ticket=await api.createTicket(c.slug,{subject:sval(d,'subject'),body:sval(d,'body'),...(d.task_slug?{task_slug:sval(d,'task_slug')}:{})});go('/c/ticket',{c:c.slug,id:ticket.id});}));
 root.append(ui.filters([select('status','Статус',['','open','answered','closed'],params().get('status'))],{c:c.slug}));
 await paged(root,offset=>api.listTickets(c.slug,{status:params().get('status'),offset,limit:24}),t=>section(t.subject,badge(t.status),badge(t.visibility),link('Открыть обращение','/c/ticket',{c:c.slug,id:t.id})));
}
export async function ticket(root:HTMLElement,c:T.Competition){
 const user=await ui.requireUser(),id=Number(params().get('id')),t=await api.getTicket(c.slug,id),staff=can(t.viewer?.permissions,'tickets.answer');
 const thread=section(t.subject);root.append(thread);
 const refresh=async()=>{
  try{const updated=await api.getTicket(c.slug,id);thread.replaceChildren(h('h2',{},updated.subject),badge(updated.status),badge(updated.visibility),...(updated.messages??[]).map(m=>h('article',{class:'card message '+(m.internal?'internal-note':'')},h('p',{class:'micro-label'},'Автор #'+m.author_id+' · '+formatDate(m.created_at)+(m.internal?' · Внутренняя заметка':'')),h('p',{class:'plain-text'},m.body))));}
  catch(e){thread.replaceChildren(ui.errorState(e,()=>void refresh()));}
 };
 await refresh();poll(refresh,15000);
 if(staff||t.opened_by===user.id||Boolean(t.team_id&&t.team_id===c.viewer.team_id))root.append(form([{...field('body','Текст сообщения','textarea'),required:true,maxlength:8000},...(staff?[field('internal','Внутренняя заметка','checkbox',false)]:[])],'Отправить сообщение',async(d,f)=>{await api.postMessage(c.slug,id,{body:sval(d,'body'),internal:Boolean(d.internal)});f.reset();await refresh();}));
 if(staff)root.append(form([select('status','Статус',['open','answered','closed'],t.status),select('visibility','Видимость',['private','public'],t.visibility)],'Изменить обращение',async d=>{await api.updateTicket(c.slug,id,{status:sval(d,'status') as T.TicketStatus,visibility:sval(d,'visibility') as T.TicketVisibility});await refresh();}));
}
export async function myCompetition(root:HTMLElement,c:T.Competition){await ui.requireUser();const r=await api.competitionSolves(c.slug);root.append(section('Мои решения',...(r.items.length?r.items.map(ui.solveCard):[empty()])));await ui.submissions(root,c.slug);}
export async function profile(root:HTMLElement){
 const user=await ui.requireUser();
 const solved=await api.mySolves({limit:24,offset:0});
 const header=h('section',{class:'profile-card grid-shell'},h('div',{class:'profile-head'},
  h('div',{},h('div',{class:'eyebrow'},'Профиль участника'),h('h2',{class:'section-title'},user.username),h('p',{class:'field-hint'},'Дата регистрации: '+formatDate(user.created_at))),
  h('div',{class:'inline-actions'},link('API-токены','/settings/tokens'),link('Публичный профиль','/u',{name:user.username}))),
  h('div',{class:'profile-stats'},metric('Мои соревнования',user.competitions_owned),metric('Я участник',user.competitions_joined),metric('Решено заданий',solved.total),metric('Получено токенов',solved.total)));
 const tab=params().get('tab')??'competitions';
 root.append(header,tabs([{label:'Соревнования',path:'/profile',q:{tab:'competitions'},active:tab==='competitions'},{label:'Решения и токены',path:'/profile',q:{tab:'solves'},active:tab==='solves'}]));
 if(tab==='solves'){await paged(root,offset=>offset===0?Promise.resolve(solved):api.mySolves({limit:24,offset}),ui.solveCard);return;}
 const competitions=h('div',{class:'profile-competitions'}),solutions=section('Решения и токены');solutions.classList.add('profile-card');
 root.append(h('div',{class:'profile-columns'},competitions,solutions));
 solutions.append(...(solved.items.length?solved.items.slice(0,5).map(ui.solveCard):[empty()]),link('Все решения и токены','/profile',{tab:'solves'}));
 for(const [mine,label] of [['owned','Мои соревнования'],['joined','Я участник'],['staff','Я организатор']]){
  const group=section(label);group.classList.add('profile-card');competitions.append(group);
  await paged(group,offset=>api.listCompetitions({mine,limit:24,offset}),c=>h('article',{class:'profile-list-item'},h('h3',{class:'profile-list-title'},c.title),h('div',{class:'profile-list-meta'},badge(c.state),c.viewer?.role?badge(c.viewer.role):null),h('div',{class:'inline-actions'},link('Открыть соревнование','/c',{c:c.slug}))));
 }
}
export async function tokens(root:HTMLElement){
 await ui.requireUser();const competitions=(await api.listCompetitions({limit:200})).items.filter(c=>c.viewer);
 const fields=[{...field('name','Название токена'),required:true},...tokenScopes.map(scope=>field(scope,'Область доступа: '+scope,'checkbox',false)),select('competition_id','Привязка к соревнованию',[{value:'',label:'Без привязки'},...competitions.map(c=>({value:String(c.id),label:c.title}))]),{...field('expires_in_days','Срок в днях','number'),min:1}];
 root.append(action('Создать API-токен',()=>{
  const dialog=h('dialog',{class:'card confirm-dialog','aria-label':'Создание токена'});
  dialog.append(h('h2',{},'Создание API-токена'),form(fields,'Выпустить токен',async d=>{
   const scopes=tokenScopes.filter(scope=>d[scope]);if(!scopes.length)throw Error('Выберите хотя бы одну область доступа');
   let result:T.CreatedApiToken|null=await api.createToken({name:sval(d,'name'),scopes,competition_id:nval(d,'competition_id'),...(d.expires_in_days?{expires_in_days:Number(d.expires_in_days)}:{})});
   dialog.close();const showing=showTokenOnce(result.token);result=null;await showing;reload();
  }),action('Отмена',()=>dialog.close()));dialog.addEventListener('close',()=>dialog.remove());document.body.append(dialog);dialog.showModal();
 }));
 const r=await api.listTokens();if(!r.items.length)root.append(empty());
 for(const t of r.items)root.append(section(t.name,h('p',{},'Префикс: '+t.prefix+' · Области доступа: '+t.scopes.join(', ')),h('p',{},'Соревнование: '+(t.competition_id??'все')+' · Истекает: '+formatDate(t.expires_at)+' · Использован: '+formatDate(t.last_used_at)),action('Отозвать токен',async()=>{if(await confirmAction('Отозвать токен «'+t.name+'»?')){await api.deleteToken(t.id);reload();}})));
}
export async function publicUser(root:HTMLElement){const u=await api.getUser(params().get('name')??'');root.append(section(u.username,h('p',{},'Дата регистрации: '+formatDate(u.created_at))),...u.competitions.map(c=>ui.competitionCard(c)));}
export async function invite(root:HTMLElement){
 await ui.requireUser();const code=params().get('code')??'',r=await api.getInvite(code);
 root.append(section('Приглашение в '+r.competition.title,badge(r.role),status(r.valid?'Приглашение действительно':'Приглашение недействительно'),r.valid?action('Принять приглашение',async()=>{await api.joinCompetition(r.competition.slug,{invite_code:code});go('/c',{c:r.competition.slug});}):null));
}
