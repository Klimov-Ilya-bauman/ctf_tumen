import * as api from '../endpoints';
import type * as T from '../types';
import {ApiError} from '../api';
import {can,roles,roleLabels} from '../permissions';
import {tabs,badge,type Field} from '../dom';
import {formatDate} from '../format';
import * as ui from './common';
const {h,section,form,action,link,secret,status,empty,confirmAction,params,go,sval,nval,reload,field,select,paged}=ui;
export const adminTabs=[['settings','Настройки','competition.edit'],['state','Состояние','competition.state'],['members','Участники','members.view'],['invites','Приглашения','invites.manage'],['requests','Заявки','requests.manage'],['announcements','Объявления','announcements.manage'],['submissions','Отправки','submissions.view_all'],['audit','Журнал','audit.view']];
const staffAccess=(c:T.Competition)=>['competition.edit','tasks.create','tasks.review','tasks.view_all'].some(p=>can(c.viewer.permissions,p));
const grantRoles=(c:T.Competition):Exclude<T.Role,'owner'>[]=>can(c.viewer.permissions,'admins.manage')?['admin','author','reviewer','participant','observer']:['author','reviewer','participant','observer'];
export async function admin(root:HTMLElement,c:T.Competition){
 if(!staffAccess(c))throw new ApiError(403,'Кабинет организатора недоступен');
 const allowed=adminTabs.filter(([, ,p])=>can(c.viewer.permissions,p));
 const tab=params().get('tab')??allowed[0]?.[0];
 if(!allowed.some(([key])=>key===tab))throw new ApiError(403,'Этот раздел недоступен');
 root.append(tabs(allowed.map(([key,label])=>({label,path:'/c/admin',q:{c:c.slug,tab:key},active:tab===key}))),link('Задания организатора','/c/admin/tasks',{c:c.slug}));
 const panel=section(allowed.find(([key])=>key===tab)![1]);panel.classList.add('admin-panel');root.append(panel);
 switch(tab){
  case 'settings':{
   const owner=can(c.viewer.permissions,'competition.transfer');
   panel.append(ui.timezone(),form(ui.competitionFields(c,owner),'Сохранить соревнование',async d=>{await api.updateCompetition(c.slug,ui.competitionBody(d));reload();}));
   if(!owner)panel.append(status('Видимость и порядок вступления изменяет только владелец. Эти поля отключены для вашей роли.'));
   break;
  }
  case 'state':{
   panel.append(badge(c.state),h('p',{},'Начало: '+formatDate(c.starts_at)+' · Окончание: '+formatDate(c.ends_at)));
   const transitions:Record<T.CompetitionState,T.CompetitionAction[]>={draft:['publish'],scheduled:['start'],running:['freeze','finish'],frozen:['unfreeze','finish'],finished:['archive'],archived:[]};
   const names:Record<T.CompetitionAction,string>={publish:'Опубликовать соревнование',start:'Начать соревнование',freeze:'Заморозить рейтинг',unfreeze:'Разморозить рейтинг',finish:'Завершить соревнование',archive:'Архивировать соревнование'};
   for(const a of transitions[c.state])panel.append(action(names[a],async()=>{if(await confirmAction(names[a]+'?')){await api.competitionState(c.slug,a);reload();}}));
   if(can(c.viewer.permissions,'competition.transfer')){
    const admins=(await api.listMembers(c.slug,{role:'admin',status:'active',limit:200})).items;
    panel.append(form([select('user_id','Новый владелец',admins.map(m=>({value:String(m.user_id),label:m.username})))],'Передать владение',async d=>{if(await confirmAction('Передать владение соревнованием?')){await api.transferCompetition(c.slug,Number(d.user_id));reload();}}));
   }
   if(can(c.viewer.permissions,'competition.delete'))panel.append(action('Удалить соревнование',async()=>{if(await confirmAction('Удалить соревнование?',c.slug)){await api.deleteCompetition(c.slug,c.slug);go('/competitions');}}));
   break;
  }
  case 'members':{
   panel.append(ui.filters([select('role','Роль',['',...roles],params().get('role')),select('status','Статус',['','active','pending','invited','banned'],params().get('status')),field('q','Поиск пользователя','search',params().get('q'))],{c:c.slug,tab}));
   await paged(panel,offset=>api.listMembers(c.slug,{role:params().get('role'),status:params().get('status'),q:params().get('q'),offset,limit:24}),m=>{
    const row=section(m.username,link('Публичный профиль','/u',{name:m.username}),badge(m.role),m.status?badge(m.status):null);
    const perms=m.viewer?.permissions;
    if(can(perms,'members.manage')||can(perms,'admins.manage'))row.append(form([select('role','Роль',grantRoles(c),m.role),select('status','Статус',['active','banned','pending','invited'],m.status)],'Изменить участника',async d=>{try{await api.updateMember(c.slug,m.user_id,{role:sval(d,'role') as T.Role,status:sval(d,'status') as T.MembershipStatus});reload();}catch(e){await api.listMembers(c.slug,{q:m.username});throw e;}}),action('Удалить участника',async()=>{if(await confirmAction('Удалить участника '+m.username+'?')){await api.deleteMember(c.slug,m.user_id);reload();}}));
    else row.append(status('Строка доступна для просмотра. Разрешение на изменение этой строки не предоставлено сервером.'));
    return row;
   });break;
  }
  case 'invites':{
   panel.append(form([select('role','Роль приглашённого',grantRoles(c),'participant'),{...field('max_uses','Максимум использований','number'),min:1},{...field('expires_in_hours','Срок в часах','number'),min:1}],'Создать приглашение',async d=>{
    const invite=await api.createInvite(c.slug,{role:sval(d,'role') as T.Invite['role'],max_uses:nval(d,'max_uses'),expires_in_hours:nval(d,'expires_in_hours')});
    await api.listInvites(c.slug);panel.append(section('Приглашение создано',secret(invite.code,'Код приглашения'),secret(ui.href('/invite',{code:invite.code}),'Ссылка приглашения')));
   }));
   const r=await api.listInvites(c.slug);if(!r.items.length)panel.append(empty());
   for(const i of r.items)panel.append(section('Приглашение · '+roleLabels[i.role],secret(i.code,'Код приглашения'),secret(ui.href('/invite',{code:i.code}),'Ссылка приглашения'),h('p',{},'Использовано: '+i.uses+' / '+(i.max_uses??'∞')+' · Срок: '+formatDate(i.expires_at)),i.revoked?status('Отозвано'):action('Отозвать приглашение',async()=>{if(await confirmAction('Отозвать приглашение?')){await api.deleteInvite(c.slug,i.code);reload();}})));
   break;
  }
  case 'requests':{
   panel.append(ui.filters([select('status','Статус заявки',['pending','approved','rejected'],params().get('status')??'pending')],{c:c.slug,tab}));
   await paged(panel,offset=>api.listRequests(c.slug,{status:params().get('status')??'pending',offset,limit:24}),r=>section('Заявка #'+r.id,h('p',{},'Участник #'+r.user_id),h('p',{class:'plain-text'},r.message),badge(r.status),r.status==='pending'?form([select('role','Роль',grantRoles(c),'participant')],'Одобрить заявку',async d=>{await api.approveRequest(c.slug,r.id,sval(d,'role') as T.Role);reload();}):null,r.status==='pending'?action('Отклонить заявку',async()=>{if(await confirmAction('Отклонить заявку?')){await api.rejectRequest(c.slug,r.id);reload();}}):null));
   break;
  }
  case 'announcements':{
   const fields=(a?:T.Announcement):Field[]=>[{...field('title','Заголовок','text',a?.title),required:true,maxlength:120},{...field('body','Текст','textarea',a?.body),required:true,maxlength:20000},select('audience','Аудитория',['all','staff','team'],a?.audience??'all'),field('team_id','ID команды для командного объявления','number',a?.team_id),field('pinned','Закреплено','checkbox',a?.pinned??false)];
   const body=(d:Record<string,string|boolean>):api.AnnouncementInput=>({title:sval(d,'title'),body:sval(d,'body'),audience:sval(d,'audience') as T.AnnouncementAudience,team_id:nval(d,'team_id'),pinned:Boolean(d.pinned)});
   panel.append(form(fields(),'Создать объявление',async d=>{await api.createAnnouncement(c.slug,body(d));reload();}));
   for(const a of (await api.listAnnouncements(c.slug)).items)panel.append(section(a.title,form(fields(a),'Сохранить объявление',async d=>{await api.updateAnnouncement(c.slug,a.id,body(d));reload();}),action('Удалить объявление',async()=>{if(await confirmAction('Удалить объявление?')){await api.deleteAnnouncement(c.slug,a.id);reload();}})));
   break;
  }
  case 'submissions':await ui.submissions(panel,c.slug);break;
  case 'audit':{
   panel.append(ui.filters([field('actor','ID автора действия','number',params().get('actor')),field('action','Действие','text',params().get('action'))],{c:c.slug,tab}));
   await paged(panel,offset=>api.listAudit(c.slug,{actor:params().get('actor'),action:params().get('action'),offset,limit:50}),e=>section(e.action,h('p',{},'Автор #'+e.actor_id+' · '+e.target_type+' #'+e.target_id+' · '+formatDate(e.created_at)),h('pre',{class:'plain-text'},JSON.stringify(e.data,null,2))),50);break;
  }
 }
}
