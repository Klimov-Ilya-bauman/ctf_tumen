import * as publicPages from './public';
import {admin} from './admin';
import {taskNew,taskEditor} from './task-editor';
import {competitionContext} from '../competition-context';
import {can} from '../permissions';
import {formatRemaining} from '../format';
import {ApiError,requireCurrentUser} from '../api';
import {h,link,badge,errorState} from '../dom';
import {region} from './common';
import type {Competition} from '../types';
const publicRoutes:Record<string,(root:HTMLElement)=>Promise<void>>={
 competitions:publicPages.catalog,'competition-new':publicPages.newCompetition,profile:publicPages.profile,tokens:publicPages.tokens,user:publicPages.publicUser,invite:publicPages.invite
};
const competitionRoutes:Record<string,(root:HTMLElement,c:Competition)=>Promise<void>>={
 overview:publicPages.overview,tasks:publicPages.tasks,task:publicPages.task,scoreboard:publicPages.scoreboard,teams:publicPages.teams,team:publicPages.team,announcements:publicPages.announcements,tickets:publicPages.tickets,ticket:publicPages.ticket,me:publicPages.myCompetition,admin,'admin-tasks':(root,c)=>{if(!can(c.viewer.permissions,'tasks.view_all'))throw new ApiError(403,'Кабинет заданий недоступен');return publicPages.tasks(root,c,true);},'task-new':taskNew,'task-editor':taskEditor
};
export async function boot(){
 const root=document.querySelector<HTMLElement>('[data-page]');if(!root)return;
 const page=root.dataset.page!;
 await region(root,async()=>{
  let c:Competition|undefined;
  if(competitionRoutes[page]){
   if(!['overview','tasks','task','scoreboard'].includes(page)){if(!await requireCurrentUser())return;}
   try{c=await competitionContext();}catch(e){
    const header=document.querySelector<HTMLElement>('[data-competition-header]');if(header)header.replaceChildren(errorState(e,()=>location.reload()));
    throw e;
   }
   renderCompetition(c);
  }
  root.replaceChildren();
  if(c)await competitionRoutes[page](root,c);else if(publicRoutes[page])await publicRoutes[page](root);
 });
}
function renderCompetition(c:Competition){
 const header=document.querySelector<HTMLElement>('[data-competition-header]'),nav=document.querySelector<HTMLElement>('[data-competition-nav]');
 if(header){header.replaceChildren(h('div',{class:'eyebrow'},'Текущее соревнование'),h('h2',{},c.title),h('p',{class:'field-hint'},'Задания и результаты на этой странице относятся к выбранному соревнованию.'),badge(c.state),badge(c.viewer.role??'Гость'));}
 if(nav){
  const items:[string,string,string?][]=[['Обзор','/c'],['Задания','/c/tasks','play.view_tasks'],['Рейтинг','/c/scoreboard','competition.view'],['Объявления','/c/announcements','competition.view']];
  if(c.team_mode)items.push(['Команды','/c/teams','members.view']);
  if(c.viewer.status)items.push(['Мои решения','/c/me'],['Обращения','/c/tickets']);
  if(['competition.edit','tasks.create','tasks.review','tasks.view_all'].some(p=>can(c.viewer.permissions,p)))items.push(['Организатор','/c/admin'],['Управление заданиями','/c/admin/tasks']);
  nav.replaceChildren(...items.filter(([,path,permission])=>!permission||can(c.viewer.permissions,permission)||path==='/c/tasks'&&can(c.viewer.permissions,'tasks.view_all')).map(([label,path])=>{const a=link(label,path,{c:c.slug});if(location.pathname.replace(/\/$/,'')===path)a.setAttribute('aria-current','page');return a;}));
 }
 const countdown=document.querySelector<HTMLElement>('[data-countdown-root]');
 if(countdown){
  const target=c.state==='scheduled'?c.starts_at:c.state==='running'?(c.freeze_at??c.ends_at):c.state==='frozen'?c.ends_at:null;
  countdown.hidden=!target;
  if(target){
   const stage=c.state==='scheduled'?'start':c.state==='running'&&c.freeze_at?'freeze':'end';
   const title=countdown.querySelector('[data-countdown-title]'),hint=countdown.querySelector('[data-countdown-hint]');
   if(title)title.textContent=stage==='start'?'До начала соревнования':stage==='freeze'?'До заморозки рейтинга':'До окончания соревнования';
   if(hint)hint.textContent=stage==='start'?'После начала соревнования станет доступна отправка флагов.':stage==='freeze'?'После заморозки рейтинга отправка флагов останется доступна.':'После окончания времени отправка флагов станет недоступна.';
   const draw=()=>{const meta=countdown.querySelector('[data-countdown-meta]');if(meta)meta.textContent=formatRemaining(target);};draw();const timer=setInterval(draw,1000);window.addEventListener('pagehide',()=>clearInterval(timer),{once:true});
  }
 }
}
