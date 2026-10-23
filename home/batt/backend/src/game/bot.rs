use rand::{Rng, RngExt, seq::IndexedRandom};
use super::{
    board::{Coord, FLEET, SIZE, Ship, neighbors8},
    rules::{ShotResult, validate_fleet},
};
pub fn random_fleet(rng: &mut impl Rng) -> Vec<Ship> {
    'attempt: loop {
        let mut ships: Vec<Ship> = Vec::with_capacity(FLEET.len());
        for &len in &FLEET {
            let mut placed = false;
            for _ in 0..200 {
                let horizontal = rng.random_bool(0.5);
                let ship = Ship {
                    x: rng.random_range(0..SIZE as u8),
                    y: rng.random_range(0..SIZE as u8),
                    len,
                    horizontal,
                };
                if ship.in_bounds() && !touches_any(&ship, &ships) {
                    ships.push(ship);
                    placed = true;
                    break;
                }
            }
            if !placed {
                continue 'attempt;
            }
        }
        debug_assert!(validate_fleet(& ships).is_ok());
        return ships;
    }
}
fn touches_any(ship: &Ship, others: &[Ship]) -> bool {
    let occupied: Vec<Coord> = others.iter().flat_map(|s| s.cells()).collect();
    ship.cells()
        .iter()
        .any(|&c| occupied.contains(&c) || neighbors8(c).any(|n| occupied.contains(&n)))
}
const ADAPTIVE_AIM_CHANCE: f64 = 0.7;
pub struct Bot {
    tried: [[bool; SIZE]; SIZE],
    hits: Vec<Coord>,
}
impl Bot {
    pub fn new() -> Self {
        Self {
            tried: [[false; SIZE]; SIZE],
            hits: Vec::new(),
        }
    }
    fn is_untried(&self, c: Coord) -> bool {
        !self.tried[c.x as usize][c.y as usize]
    }
    fn step(c: Coord, dx: i32, dy: i32) -> Option<Coord> {
        let x = c.x as i32 + dx;
        let y = c.y as i32 + dy;
        let range = 0..SIZE as i32;
        (range.contains(&x) && range.contains(&y))
            .then(|| Coord { x: x as u8, y: y as u8 })
    }
    fn target_candidates(&self) -> Vec<Coord> {
        let mut out = Vec::new();
        if self.hits.len() == 1 {
            for (dx, dy) in [(1, 0), (-1, 0), (0, 1), (0, -1)] {
                out.extend(Self::step(self.hits[0], dx, dy));
            }
        } else if self.hits.len() > 1 {
            let horizontal = self.hits[0].y == self.hits[1].y;
            let (dx, dy) = if horizontal { (1, 0) } else { (0, 1) };
            let first = *self.hits.iter().min_by_key(|c| (c.x, c.y)).unwrap();
            let last = *self.hits.iter().max_by_key(|c| (c.x, c.y)).unwrap();
            out.extend(Self::step(first, -dx, -dy));
            out.extend(Self::step(last, dx, dy));
        }
        out.retain(|&c| self.is_untried(c));
        out
    }
    pub fn next_shot(&self, rng: &mut impl Rng, aim_hint: &[Coord]) -> Coord {
        let targets = self.target_candidates();
        if let Some(&c) = targets.choose(rng) {
            return c;
        }
        let hinted: Vec<Coord> = aim_hint
            .iter()
            .copied()
            .filter(|&c| self.is_untried(c))
            .collect();
        if !hinted.is_empty() && rng.random_bool(ADAPTIVE_AIM_CHANCE) {
            return *hinted.choose(rng).expect("checked non-empty above");
        }
        let all: Vec<Coord> = (0..SIZE as u8)
            .flat_map(|x| (0..SIZE as u8).map(move |y| Coord { x, y }))
            .filter(|&c| self.is_untried(c))
            .collect();
        let parity: Vec<Coord> = all
            .iter()
            .copied()
            .filter(|c| (c.x + c.y) % 2 == 0)
            .collect();
        let pool = if parity.is_empty() { &all } else { &parity };
        *pool.choose(rng).expect("no cells left to shoot")
    }
    pub fn report(&mut self, c: Coord, result: &ShotResult) {
        self.tried[c.x as usize][c.y as usize] = true;
        match result {
            ShotResult::Miss => {}
            ShotResult::Hit => self.hits.push(c),
            ShotResult::Sunk(ship) => {
                for cell in ship.cells() {
                    self.tried[cell.x as usize][cell.y as usize] = true;
                    for n in neighbors8(cell) {
                        self.tried[n.x as usize][n.y as usize] = true;
                    }
                }
                self.hits.clear();
            }
        }
    }
}
