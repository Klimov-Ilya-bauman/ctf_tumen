use serde::{Deserialize, Serialize};
pub const SIZE: usize = 10;
pub const FLEET: [u8; 10] = [4, 3, 3, 2, 2, 2, 1, 1, 1, 1];
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub struct Coord {
    pub x: u8,
    pub y: u8,
}
impl Coord {
    pub fn in_bounds(&self) -> bool {
        (self.x as usize) < SIZE && (self.y as usize) < SIZE
    }
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Ship {
    pub x: u8,
    pub y: u8,
    pub len: u8,
    pub horizontal: bool,
}
impl Ship {
    pub fn cells(&self) -> Vec<Coord> {
        (0..self.len)
            .map(|i| {
                if self.horizontal {
                    Coord {
                        x: self.x.saturating_add(i),
                        y: self.y,
                    }
                } else {
                    Coord {
                        x: self.x,
                        y: self.y.saturating_add(i),
                    }
                }
            })
            .collect()
    }
    pub fn in_bounds(&self) -> bool {
        if self.len == 0 {
            return false;
        }
        let (x_end, y_end) = if self.horizontal {
            (self.x as usize + self.len as usize - 1, self.y as usize)
        } else {
            (self.x as usize, self.y as usize + self.len as usize - 1)
        };
        (self.x as usize) < SIZE && (self.y as usize) < SIZE && x_end < SIZE
            && y_end < SIZE
    }
}
pub fn neighbors8(c: Coord) -> impl Iterator<Item = Coord> {
    (-1i32..=1)
        .flat_map(move |dx| (-1i32..=1).map(move |dy| (dx, dy)))
        .filter_map(move |(dx, dy)| {
            if dx == 0 && dy == 0 {
                return None;
            }
            let x = c.x as i32 + dx;
            let y = c.y as i32 + dy;
            (0..SIZE as i32).contains(&x).then_some(())?;
            (0..SIZE as i32).contains(&y).then_some(())?;
            Some(Coord { x: x as u8, y: y as u8 })
        })
}
