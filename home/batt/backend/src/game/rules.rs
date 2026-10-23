use super::board::{Coord, FLEET, SIZE, Ship, neighbors8};
#[derive(Debug, PartialEq, Eq)]
pub enum FleetError {
    WrongComposition,
    OutOfBounds,
    Touching,
}
pub fn validate_fleet(ships: &[Ship]) -> Result<(), FleetError> {
    let mut lens: Vec<u8> = ships.iter().map(|s| s.len).collect();
    lens.sort_unstable_by(|a, b| b.cmp(a));
    if lens != FLEET {
        return Err(FleetError::WrongComposition);
    }
    if ships.iter().any(|s| !s.in_bounds()) {
        return Err(FleetError::OutOfBounds);
    }
    let mut owner = [[None::<usize>; SIZE]; SIZE];
    for (i, ship) in ships.iter().enumerate() {
        for c in ship.cells() {
            let (x, y) = (c.x as usize, c.y as usize);
            if owner[x][y].is_some() {
                return Err(FleetError::Touching);
            }
            owner[x][y] = Some(i);
        }
    }
    for (i, ship) in ships.iter().enumerate() {
        for c in ship.cells() {
            for n in neighbors8(c) {
                if let Some(j) = owner[n.x as usize][n.y as usize] {
                    if j != i {
                        return Err(FleetError::Touching);
                    }
                }
            }
        }
    }
    Ok(())
}
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Mark {
    Unknown,
    Miss,
    Hit,
}
#[derive(Debug, PartialEq, Eq)]
pub enum ShotResult {
    Miss,
    Hit,
    Sunk(Ship),
}
#[derive(Debug, PartialEq, Eq)]
pub enum FireError {
    OutOfBounds,
    AlreadyShot,
}
pub struct Board {
    ships: Vec<Ship>,
    marks: [[Mark; SIZE]; SIZE],
}
impl Board {
    pub fn new(ships: Vec<Ship>) -> Result<Self, FleetError> {
        validate_fleet(&ships)?;
        Ok(Self {
            ships,
            marks: [[Mark::Unknown; SIZE]; SIZE],
        })
    }
    pub fn ships(&self) -> &[Ship] {
        &self.ships
    }
    pub fn mark(&self, c: Coord) -> Mark {
        self.marks[c.x as usize][c.y as usize]
    }
    pub fn fire(&mut self, c: Coord) -> Result<ShotResult, FireError> {
        if !c.in_bounds() {
            return Err(FireError::OutOfBounds);
        }
        if self.mark(c) != Mark::Unknown {
            return Err(FireError::AlreadyShot);
        }
        let Some(ship) = self.ships.iter().find(|s| s.cells().contains(&c)).cloned()
        else {
            self.marks[c.x as usize][c.y as usize] = Mark::Miss;
            return Ok(ShotResult::Miss);
        };
        self.marks[c.x as usize][c.y as usize] = Mark::Hit;
        if ship.cells().iter().all(|&cell| self.mark(cell) == Mark::Hit) {
            for cell in ship.cells() {
                for n in neighbors8(cell) {
                    if self.mark(n) == Mark::Unknown {
                        self.marks[n.x as usize][n.y as usize] = Mark::Miss;
                    }
                }
            }
            Ok(ShotResult::Sunk(ship))
        } else {
            Ok(ShotResult::Hit)
        }
    }
    pub fn all_sunk(&self) -> bool {
        self.ships.iter().all(|s| s.cells().iter().all(|&c| self.mark(c) == Mark::Hit))
    }
}
