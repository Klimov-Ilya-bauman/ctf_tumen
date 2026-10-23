import {h, link, badge, type Child} from '../dom';
import {can} from '../permissions';
import {formatDate} from '../format';
import type {TaskSummary} from '../types';

export function metric(label:string, value:string|number) {
  return h('div', {class:'stat-card'}, h('div', {class:'stat-value'}, value), h('div', {class:'stat-label'}, label));
}

export function facts(items:[string, Child][]) {
  return h('dl', {class:'detail-facts'}, ...items.map(([label,value]) =>
    h('div', {}, h('dt', {class:'micro-label'}, label), h('dd', {}, value))));
}

export function taskCard(c:string, task:TaskSummary) {
  const open=link('Открыть задание','/c/task',{c,t:task.slug});
  open.className='btn-secondary btn-small';
  const difficulty=badge(task.difficulty);difficulty.className='difficulty '+task.difficulty;
  return h('article', {class:'task-card card '+task.difficulty},
    h('div', {class:'task-card-head'}, h('div', {class:'task-badges'}, difficulty,
      task.state?badge(task.state):null, task.has_solved?h('span',{class:'solved-pill'},'Решено вами'):null)),
    h('div', {class:'task-card-body'}, h('h3', {class:'task-title'}, task.title),
      h('p',{class:'task-card-description'}, task.category),
      h('div',{class:'task-card-meta'},
        h('div',{},h('span',{class:'micro-label'},'Баллы'),h('strong',{},task.points)),
        h('div',{},h('span',{class:'micro-label'},'Решений'),h('strong',{},task.solve_count)),
        task.release_at?h('div',{},h('span',{class:'micro-label'},'Открытие'),formatDate(task.release_at)):null)),
    h('div', {class:'task-card-footer'},
      task.author?h('span',{class:'task-card-author'},task.author.username):null,
      h('div',{class:'inline-actions'},open,
        can(task.viewer_permissions,'task.edit')?link('Редактировать','/c/admin/task',{c,t:task.slug}):
        can(task.viewer_permissions,'task.view_secrets')?link('Кабинет задания','/c/admin/task',{c,t:task.slug,tab:'review'}):null)));
}
