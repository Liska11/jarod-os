//! Sidecar stdio autour de turbovec (Q15, accord B17).
//!
//! Protocole en lignes, une commande par ligne, une réponse par ligne : `ok …` ou `err <code> <message>`.
//! Vecteurs f32 et identifiants u64 en petit-boutien ; en ligne ils passent en base64, en masse par fichier.
//!
//!   new <dim> <bits>                         index vide (bits : 2, 3 ou 4)
//!   load <path>                              charge un index écrit par write/sync
//!   calibrate <f32-file>                     TQ+ sur un échantillon (≈1024 lignes)
//!   addfile <f32-file> <u64-file>            ajout en masse
//!   add <id> <f32-b64>                       ajout d'un vecteur
//!   remove <id>                              -> ok 1|0
//!   prepare                                  construit les structures de recherche
//!   search <k> <f32-b64> [<u64-b64>]         -> ok id:score id:score … (allowlist facultative)
//!   benchsearch <k> <f32-file> <out-file>    toutes les requêtes du fichier ; écrit k ids u64 par requête
//!                                            -> ok <n> <µs par requête, séparés par des virgules>
//!   sync <path> | write <path>               persistance
//!   len                                      -> ok <n>
//!   quit
//!
//! Aucune dépendance hors turbovec : le base64 est décodé ici.

use std::io::{self, BufRead, Write};
use std::time::Instant;
use turbovec::IdMapIndex;

type R = Result<String, (String, String)>;

fn bad(code: &str, msg: impl ToString) -> (String, String) {
    (code.to_string(), msg.to_string())
}

fn b64(s: &str) -> Result<Vec<u8>, (String, String)> {
    fn v(c: u8) -> Option<u32> {
        match c {
            b'A'..=b'Z' => Some((c - b'A') as u32),
            b'a'..=b'z' => Some((c - b'a' + 26) as u32),
            b'0'..=b'9' => Some((c - b'0' + 52) as u32),
            b'+' | b'-' => Some(62),
            b'/' | b'_' => Some(63),
            _ => None,
        }
    }
    let bytes: Vec<u8> = s.bytes().filter(|&c| c != b'=').collect();
    let mut out = Vec::with_capacity(bytes.len() * 3 / 4);
    for chunk in bytes.chunks(4) {
        let mut acc = 0u32;
        for (i, &c) in chunk.iter().enumerate() {
            acc |= v(c).ok_or_else(|| bad("base64", "caractère invalide"))? << (18 - 6 * i);
        }
        let n = match chunk.len() {
            4 => 3,
            3 => 2,
            2 => 1,
            _ => return Err(bad("base64", "longueur invalide")),
        };
        for i in 0..n {
            out.push((acc >> (16 - 8 * i)) as u8);
        }
    }
    Ok(out)
}

fn f32s(b: &[u8]) -> Result<Vec<f32>, (String, String)> {
    if b.len() % 4 != 0 {
        return Err(bad("format", "f32 : longueur non multiple de 4"));
    }
    Ok(b.chunks_exact(4).map(|c| f32::from_le_bytes([c[0], c[1], c[2], c[3]])).collect())
}

fn u64s(b: &[u8]) -> Result<Vec<u64>, (String, String)> {
    if b.len() % 8 != 0 {
        return Err(bad("format", "u64 : longueur non multiple de 8"));
    }
    Ok(b.chunks_exact(8).map(|c| u64::from_le_bytes(c.try_into().unwrap())).collect())
}

fn read(path: &str) -> Result<Vec<u8>, (String, String)> {
    std::fs::read(path).map_err(|e| bad("io", e))
}

fn need(ix: &mut Option<IdMapIndex>) -> Result<&mut IdMapIndex, (String, String)> {
    ix.as_mut().ok_or_else(|| bad("state", "aucun index (new ou load d'abord)"))
}

fn arg<'a>(a: &[&'a str], i: usize) -> Result<&'a str, (String, String)> {
    a.get(i).copied().ok_or_else(|| bad("args", format!("argument {} manquant", i)))
}

fn num<T: std::str::FromStr>(s: &str) -> Result<T, (String, String)> {
    s.parse().map_err(|_| bad("args", format!("nombre invalide : {}", s)))
}

fn handle(ix: &mut Option<IdMapIndex>, line: &str) -> R {
    let a: Vec<&str> = line.split_whitespace().collect();
    match a.first().copied().unwrap_or("") {
        "new" => {
            let (dim, bits) = (num(arg(&a, 1)?)?, num(arg(&a, 2)?)?);
            *ix = Some(IdMapIndex::new(dim, bits).map_err(|e| bad("construct", e))?);
            Ok(String::new())
        }
        "load" => {
            *ix = Some(IdMapIndex::load(arg(&a, 1)?).map_err(|e| bad("io", e))?);
            Ok(ix.as_ref().unwrap().len().to_string())
        }
        "calibrate" => {
            let v = f32s(&read(arg(&a, 1)?)?)?;
            need(ix)?.calibrate(&v).map_err(|e| bad("calibrate", e))?;
            Ok(String::new())
        }
        "addfile" => {
            let v = f32s(&read(arg(&a, 1)?)?)?;
            let ids = u64s(&read(arg(&a, 2)?)?)?;
            let x = need(ix)?;
            x.add_with_ids(&v, &ids).map_err(|e| bad("add", e))?;
            Ok(x.len().to_string())
        }
        "add" => {
            let id: u64 = num(arg(&a, 1)?)?;
            let v = f32s(&b64(arg(&a, 2)?)?)?;
            need(ix)?.add_with_ids(&v, &[id]).map_err(|e| bad("add", e))?;
            Ok(String::new())
        }
        "remove" => {
            let id: u64 = num(arg(&a, 1)?)?;
            Ok(if need(ix)?.remove(id) { "1" } else { "0" }.to_string())
        }
        "prepare" => {
            need(ix)?.prepare();
            Ok(String::new())
        }
        "search" => {
            let k: usize = num(arg(&a, 1)?)?;
            let q = f32s(&b64(arg(&a, 2)?)?)?;
            let allow = match a.get(3) {
                Some(s) => Some(u64s(&b64(s)?)?),
                None => None,
            };
            let x = need(ix)?;
            let r = x.try_search_with_allowlist(&q, k, allow.as_deref()).map_err(|e| bad("search", e))?;
            let out: Vec<String> = r
                .ids_for_query(0)
                .iter()
                .zip(r.scores_for_query(0))
                .map(|(id, s)| format!("{}:{}", id, s))
                .collect();
            Ok(out.join(" "))
        }
        "benchsearch" => {
            let k: usize = num(arg(&a, 1)?)?;
            let q = f32s(&read(arg(&a, 2)?)?)?;
            let out_path = arg(&a, 3)?;
            let x = need(ix)?;
            let dim = x.dim_opt().ok_or_else(|| bad("state", "index sans dimension"))?;
            let mut ids_out: Vec<u8> = Vec::new();
            let mut times: Vec<String> = Vec::new();
            for row in q.chunks_exact(dim) {
                let t = Instant::now();
                let r = x.try_search(row, k).map_err(|e| bad("search", e))?;
                times.push(t.elapsed().as_micros().to_string());
                let got = r.ids_for_query(0);
                for i in 0..k {
                    ids_out.extend_from_slice(&got.get(i).copied().unwrap_or(u64::MAX).to_le_bytes());
                }
            }
            std::fs::write(out_path, ids_out).map_err(|e| bad("io", e))?;
            Ok(format!("{} {}", times.len(), times.join(",")))
        }
        "sync" => {
            need(ix)?.sync(arg(&a, 1)?).map_err(|e| bad("io", e))?;
            Ok(String::new())
        }
        "write" => {
            need(ix)?.write(arg(&a, 1)?).map_err(|e| bad("io", e))?;
            Ok(String::new())
        }
        "len" => Ok(need(ix)?.len().to_string()),
        other => Err(bad("unknown", format!("commande inconnue : {}", other))),
    }
}

fn main() {
    let stdin = io::stdin();
    let mut out = io::BufWriter::new(io::stdout().lock());
    let mut ix: Option<IdMapIndex> = None;
    for line in stdin.lock().lines() {
        let Ok(line) = line else { break };
        let line = line.trim();
        if line.is_empty() {
            continue;
        }
        if line == "quit" {
            break;
        }
        let reply = match handle(&mut ix, line) {
            Ok(s) if s.is_empty() => "ok".to_string(),
            Ok(s) => format!("ok {}", s),
            Err((code, msg)) => format!("err {} {}", code, msg.replace('\n', " ")),
        };
        let _ = writeln!(out, "{}", reply);
        let _ = out.flush();
    }
}
