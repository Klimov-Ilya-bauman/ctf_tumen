import * as api from '../endpoints';
import type * as T from '../types';
import {ApiError} from '../api';
import {can} from '../permissions';
import {tabs,badge,type Field} from '../dom';
import {localDateInput,formatDate} from '../format';
import {attachmentLink} from './public';
import * as ui from './common';
const {h,section,form,action,link,secret,status,empty,confirmAction,params,go,sval,nval,reload,field,select}=ui;
function details(t?:T.ManagedTask):Field[]{return [
 {name:'title',label:'Название задания',required:true,minlength:3,maxlength:120,value:t?.title},
 {name:'description',label:'Условие задания',type:'textarea',required:true,minlength:10,maxlength:8000,value:t?.description},
 {name:'category',label:'Категория',required:true,minlength:1,maxlength:40,value:t?.category},
 select('difficulty','Сложность',['easy','medium','hard'],t?.difficulty??'easy'),
 {name:'base_points',label:'Базовые очки',type:'number',required:true,min:0,value:t?.base_points??100,disabled:t?!t.can_edit_secrets:false},
 field('release_at','Дата открытия задания','datetime-local',localDateInput(t?.release_at)),
 {...field('max_solves','Максимум решений','number',t?.max_solves),min:1}
];}
const secretFields:Field[]=[{name:'answer_flag',label:'Правильный флаг',type:'password',required:true,maxlength:512},{name:'reward_token',label:'Токен награды',type:'password',required:true,maxlength:1024}];
function taskBody(d:Record<string,string|boolean>):Partial<T.TaskCreate>{
 return {...d,...('base_points'in d?{base_points:Number(d.base_points)}:{}),...('release_at'in d?{release_at:d.release_at?new Date(sval(d,'release_at')).toISOString():null}:{}),...('max_solves'in d?{max_solves:nval(d,'max_solves')}: {})} as Partial<T.TaskCreate>;
}
export async function taskNew(root:HTMLElement,c:T.Competition){
 if(!can(c.viewer.permissions,'tasks.create'))throw new ApiError(403,'Создание заданий недоступно');
 const panel=section('Создать задание',ui.timezone(),form([...details(),...secretFields],'Создать задание',async d=>{const t=await api.createTask(c.slug,taskBody(d) as T.TaskCreate);go('/c/admin/task',{c:c.slug,t:t.slug});}));panel.classList.add('editor-card');root.append(panel);
}
const editorTabs=[['details','Условие','task.view_secrets'],['secrets','Секреты','task.view_secrets'],['attachments','Файлы','task.view_secrets'],['hints','Подсказки','task.view_secrets'],['revisions','Ревизии','task.view_secrets'],['grants','Доступ','task.grant'],['submissions','Отправки','task.view_submissions'],['review','Проверка','task.view_secrets']];
export async function taskEditor(root:HTMLElement,c:T.Competition){
 const slug=params().get('t')??'',t=await api.manageTask(c.slug,slug),p=t.viewer_permissions;
 const allowed=editorTabs.filter(([, ,perm])=>can(p,perm)),tab=params().get('tab')??allowed[0]?.[0];
 if(!allowed.some(([key])=>key===tab))throw new ApiError(403,'Раздел задания недоступен');
 root.append(section(t.title,t.state?badge(t.state):null,link('Игровая страница','/c/task',{c:c.slug,t:slug})),tabs(allowed.map(([key,label])=>({label,path:'/c/admin/task',q:{c:c.slug,t:slug,tab:key},active:tab===key}))));
 const panel=section(allowed.find(([key])=>key===tab)![1]);panel.classList.add('editor-card');root.append(panel);
 const refresh=()=>reload();
 switch(tab){
  case 'details':{
   if(can(p,'task.edit'))panel.append(ui.timezone(),form(details(t),'Сохранить задание',async d=>{await api.updateTask(c.slug,slug,taskBody(d));refresh();}));
   else panel.append(h('p',{class:'plain-text'},t.description),status('Редактирование недоступно'));
   if(can(p,'task.delete')&&!t.solve_count)panel.append(action('Удалить задание',async()=>{if(await confirmAction('Удалить задание?')){await api.deleteTask(c.slug,slug);go('/c/admin/tasks',{c:c.slug});}}));
   break;
  }
  case 'secrets':{
   panel.append(secret(t.answer_flag,'Правильный флаг'),secret(t.reward_token,'Токен награды'));
   if(can(p,'task.edit'))panel.append(form(secretFields.map(f=>({...f,disabled:!t.can_edit_secrets})),'Заменить секреты',async d=>{await api.updateTask(c.slug,slug,taskBody(d));refresh();}));
   if(!t.can_edit_secrets)panel.append(status('Секреты и базовые очки нельзя менять после первого решения или без права редактирования.'));
   break;
  }
  case 'attachments':{
   const attachments=(await api.listAttachments(c.slug,slug)).items;
   if(can(p,'task.attach')){
    const progress=h('progress',{'aria-label':'Загрузка файла',max:100,hidden:true});
    const upload=async(file:File,visibility:string)=>{
     if(file.size>20*1024*1024)throw Error('Файл больше 20 МБ');if(attachments.length>=10)throw Error('Уже загружено 10 файлов');
     const body=new FormData();body.set('file',file);body.set('visibility',visibility);
     progress.hidden=false;progress.removeAttribute('value');
     try{await api.uploadAttachment(c.slug,slug,body);progress.value=100;refresh();}finally{progress.hidden=true;}
    };
    const f=form([{...field('file','Файл','file'),required:true},select('visibility','Видимость файла',['participants','staff'],'participants')],'Загрузить файл',async(d,form)=>{
     const file=(form.elements.namedItem('file') as HTMLInputElement).files?.[0];if(!file)throw Error('Выберите файл');await upload(file,sval(d,'visibility'));
    });
    f.classList.add('drop-zone');f.addEventListener('dragover',e=>e.preventDefault());f.addEventListener('drop',e=>{e.preventDefault();const input=f.elements.namedItem('file') as HTMLInputElement;if(e.dataTransfer?.files.length){input.files=e.dataTransfer.files;f.requestSubmit();}});
    panel.append(status('Перетащите файл в форму или выберите его кнопкой. До 20 МБ на файл, до 10 файлов на задание.'),f,progress);
   }
   if(!attachments.length)panel.append(empty());
   for(const a of attachments)panel.append(section(a.filename,await attachmentLink(c.slug,a),badge(a.visibility),can(p,'task.attach')?form([field('filename','Имя файла','text',a.filename),select('visibility','Видимость',['participants','staff'],a.visibility)],'Сохранить файл',async d=>{await api.updateAttachment(c.slug,a.id,{filename:sval(d,'filename'),visibility:sval(d,'visibility') as T.AttachmentVisibility});refresh();}):null,can(p,'task.attach')?action('Удалить файл',async()=>{if(await confirmAction('Удалить файл?')){await api.deleteAttachment(c.slug,a.id);refresh();}}):null));
   break;
  }
  case 'hints':{
   const hints=(await api.listHints(c.slug,slug)).items;
   const fields=(hint?:T.HintView):Field[]=>[{...field('body','Текст подсказки','textarea',hint?.body),required:true,maxlength:8000},{...field('cost','Стоимость в очках','number',hint?.cost??0),required:true,min:0},{...field('order','Порядковый номер','number',hint?.order??hints.length+1),required:true,min:1}];
   const body=(d:Record<string,string|boolean>)=>({body:sval(d,'body'),cost:Number(d.cost),order:Number(d.order)});
   if(can(p,'task.edit'))panel.append(form(fields(),'Добавить подсказку',async d=>{await api.createHint(c.slug,slug,body(d));refresh();}));
   if(!hints.length)panel.append(empty());
   for(const hint of hints)panel.append(section('Подсказка № '+hint.order,can(p,'task.edit')?form(fields(hint),'Сохранить подсказку',async d=>{await api.updateHint(c.slug,hint.id,body(d));refresh();}):h('p',{class:'plain-text'},hint.body),can(p,'task.edit')?action('Удалить подсказку',async()=>{if(await confirmAction('Удалить подсказку?')){await api.deleteHint(c.slug,hint.id);refresh();}}):null));
   break;
  }
  case 'revisions':{
   const revisions=(await api.listRevisions(c.slug,slug)).items,comparison=section('Сравнение с текущей ревизией');panel.append(comparison);
   for(const revision of revisions)panel.append(action('Ревизия '+revision.revision+' · '+formatDate(revision.created_at),async()=>{
    const r=await api.getRevision(c.slug,slug,revision.revision);comparison.replaceChildren(h('h3',{},'Ревизия '+r.revision+' → текущая '+t.revision));
    for(const key of ['title','description','category','difficulty','base_points','answer_flag','reward_token','release_at'] as const){
     const old=String(r[key]??''),current=String(t[key]??'');
     comparison.append(section(key+(old===current?' · Не изменилось':' · Изменено'),h('p',{},'Предыдущее значение'),key==='answer_flag'||key==='reward_token'?secret(old,'Ранее'):h('p',{class:'plain-text'},old),h('p',{},'Текущее значение'),key==='answer_flag'||key==='reward_token'?secret(current,'Сейчас'):h('p',{class:'plain-text'},current)));
    }
   }));if(!revisions.length)panel.append(empty());break;
  }
  case 'grants':{
   const search=field('q','Поиск организатора','search',params().get('q'));panel.append(ui.filters([search],{c:c.slug,t:slug,tab}));
   const members=(await Promise.all(['author','reviewer','admin'].map(role=>api.listMembers(c.slug,{role,q:params().get('q'),limit:200})))).flatMap(r=>r.items);
   panel.append(form([select('user_id','Организатор',members.map(m=>({value:String(m.user_id),label:m.username}))),select('permission','Уровень доступа',['view','edit','manage'],'view')],'Выдать доступ',async d=>{await api.createGrant(c.slug,slug,{user_id:Number(d.user_id),permission:sval(d,'permission') as T.TaskGrantPermission});refresh();}));
   const grants=(await api.listGrants(c.slug,slug)).items;if(!grants.length)panel.append(empty());
   for(const grant of grants)panel.append(section('Участник #'+grant.user_id,badge(grant.permission),action('Отозвать доступ',async()=>{if(await confirmAction('Отозвать доступ?')){await api.deleteGrant(c.slug,slug,grant.user_id);refresh();}})));break;
  }
  case 'submissions':await ui.submissions(panel,c.slug,slug);break;
  case 'review':{
   const transitions:Record<T.TaskState,{action:T.TaskAction;permission:string;label:string}[]>={
    draft:[{action:'submit',permission:'task.edit',label:'Отправить на проверку'}],
    review:[{action:'approve',permission:'task.review',label:'Одобрить и опубликовать'},{action:'reject',permission:'task.review',label:'Вернуть на доработку'}],
    published:[{action:'hide',permission:'task.publish',label:'Скрыть задание'},{action:'archive',permission:'task.publish',label:'Архивировать задание'}],
    hidden:[{action:'publish',permission:'task.publish',label:'Опубликовать задание'},{action:'archive',permission:'task.publish',label:'Архивировать задание'}],archived:[]
   };
   for(const transition of transitions[t.state??'draft'].filter(x=>can(p,x.permission)))panel.append(form([field('comment','Комментарий к переходу','textarea')],transition.label,async d=>{if(await confirmAction(transition.label+'?')){await api.taskState(c.slug,slug,transition.action,sval(d,'comment'));refresh();}}));
   panel.append(status('Одобрение сразу публикует задание согласно API-схеме. Доступность игрокам также зависит от соревнования и даты открытия.'));
   break;
  }
 }
}

