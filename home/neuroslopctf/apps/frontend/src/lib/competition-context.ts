import {getCompetition} from './endpoints';
import type {Competition} from './types';
let current:Promise<Competition>|undefined;
export function competitionContext(refresh=false):Promise<Competition> {
 if(!current||refresh) {
  const slug=new URLSearchParams(location.search).get('c');
  current=slug?getCompetition(slug):Promise.reject(new Error('Не указан идентификатор соревнования'));
  current.then(competition=>document.dispatchEvent(new CustomEvent('competition:loaded',{detail:competition})),()=>{});
 }
 return current;
}
