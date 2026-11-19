// Monitor de sistema para la cabecera: CPU, RAM y swap. En Linux se leen de /proc (sin
// procesos extra); en macOS, con sysinfo.

use serde::Serialize;
use std::sync::Mutex;
use tauri::State;

#[derive(Default)]
pub struct SysMon {
    /// Contadores de CPU de la lectura anterior (tiempo ocioso, total), para sacar el % entre dos.
    #[cfg(not(target_os = "macos"))]
    prev: Mutex<Option<(u64, u64)>>,
    /// sysinfo saca el % de CPU entre dos refrescos del mismo System.
    #[cfg(target_os = "macos")]
    sys: Mutex<Option<sysinfo::System>>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SysStats {
    /// Uso de CPU entre esta lectura y la anterior, de 0 a 100 (None en la primera).
    cpu: Option<f64>,
    cores: usize,
    /// Bytes.
    mem_total: u64,
    mem_available: u64,
    swap_total: u64,
    swap_free: u64,
    /// Carga promedio del último minuto.
    load1: f64,
}

/// (ocioso, total) de la línea "cpu" de /proc/stat.
#[cfg(not(target_os = "macos"))]
fn cpu_times() -> Option<(u64, u64)> {
    let stat = std::fs::read_to_string("/proc/stat").ok()?;
    let line = stat.lines().next()?;
    let v: Vec<u64> = line.split_whitespace().skip(1).filter_map(|x| x.parse().ok()).collect();
    // user nice system idle iowait irq softirq steal (guest ya está incluido en user).
    let idle = v.get(3)? + v.get(4).unwrap_or(&0);
    let total = v.iter().take(8).sum();
    Some((idle, total))
}

#[cfg(not(target_os = "macos"))]
#[tauri::command]
pub fn sys_stats(mon: State<'_, SysMon>) -> SysStats {
    let now = cpu_times();
    let cpu = {
        let mut prev = mon.prev.lock().unwrap();
        let pct = match (*prev, now) {
            (Some((pi, pt)), Some((ni, nt))) if nt > pt => {
                Some(100.0 * (1.0 - (ni.saturating_sub(pi)) as f64 / (nt - pt) as f64))
            }
            _ => None,
        };
        *prev = now;
        pct
    };
    let meminfo = std::fs::read_to_string("/proc/meminfo").unwrap_or_default();
    let kb = |key: &str| -> u64 {
        meminfo
            .lines()
            .find(|l| l.starts_with(key))
            .and_then(|l| l.split_whitespace().nth(1))
            .and_then(|n| n.parse::<u64>().ok())
            .unwrap_or(0)
            * 1024
    };
    let load1 = std::fs::read_to_string("/proc/loadavg")
        .ok()
        .and_then(|s| s.split_whitespace().next()?.parse().ok())
        .unwrap_or(0.0);
    SysStats {
        cpu,
        cores: std::thread::available_parallelism().map(|n| n.get()).unwrap_or(1),
        mem_total: kb("MemTotal:"),
        mem_available: kb("MemAvailable:"),
        swap_total: kb("SwapTotal:"),
        swap_free: kb("SwapFree:"),
        load1,
    }
}

#[cfg(target_os = "macos")]
#[tauri::command]
pub fn sys_stats(mon: State<'_, SysMon>) -> SysStats {
    let mut guard = mon.sys.lock().unwrap();
    let first = guard.is_none();
    let sys = guard.get_or_insert_with(sysinfo::System::new);
    sys.refresh_cpu_usage();
    sys.refresh_memory();
    SysStats {
        cpu: (!first).then(|| sys.global_cpu_usage() as f64),
        cores: std::thread::available_parallelism().map(|n| n.get()).unwrap_or(1),
        mem_total: sys.total_memory(),
        mem_available: sys.available_memory(),
        swap_total: sys.total_swap(),
        swap_free: sys.free_swap(),
        load1: sysinfo::System::load_average().one,
    }
}
