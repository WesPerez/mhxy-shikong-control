use std::{
    env,
    io::{self, Read, Write},
    net::{IpAddr, Ipv4Addr, SocketAddr, TcpListener, TcpStream},
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    },
    thread::{self, JoinHandle},
    time::Duration,
};

pub const INSTANCE_PORT_ENV: &str = "MHXY_SHIKONG_CONTROL_INSTANCE_PORT";
const INSTANCE_HOST: &str = "127.0.0.1";
const INSTANCE_PORT: u16 = 47638;
const INSTANCE_COMMAND: &[u8] = b"MHXY-ShiKong-Control:show\n";
const INSTANCE_ACK: &[u8] = b"ok\n";
const LISTENER_IDLE_SLEEP: Duration = Duration::from_millis(30);
pub const DEFAULT_NOTIFY_TIMEOUT: Duration = Duration::from_millis(250);

#[derive(Debug)]
pub struct SingleInstanceGuard {
    stop: Arc<AtomicBool>,
    join: Mutex<Option<JoinHandle<()>>>,
}

impl Drop for SingleInstanceGuard {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::SeqCst);
        if let Ok(mut join) = self.join.lock() {
            if let Some(handle) = join.take() {
                let _ = handle.join();
            }
        }
    }
}

pub fn default_instance_addr() -> SocketAddr {
    let port = env::var(INSTANCE_PORT_ENV)
        .ok()
        .and_then(|value| value.parse::<u16>().ok())
        .filter(|port| *port != 0)
        .unwrap_or(INSTANCE_PORT);
    SocketAddr::new(
        INSTANCE_HOST
            .parse::<IpAddr>()
            .unwrap_or(IpAddr::V4(Ipv4Addr::LOCALHOST)),
        port,
    )
}

pub fn notify_existing_instance(timeout: Duration) -> bool {
    notify_existing_instance_at(default_instance_addr(), timeout)
}

pub fn notify_existing_instance_at(addr: SocketAddr, timeout: Duration) -> bool {
    let Ok(mut stream) = TcpStream::connect_timeout(&addr, timeout) else {
        return false;
    };
    let _ = stream.set_read_timeout(Some(timeout));
    let _ = stream.set_write_timeout(Some(timeout));
    if stream.write_all(INSTANCE_COMMAND).is_err() {
        return false;
    }
    let mut ack = vec![0; INSTANCE_ACK.len()];
    stream.read_exact(&mut ack).is_ok() && ack == INSTANCE_ACK
}

pub fn start_listener<F>(on_wake: F) -> io::Result<SingleInstanceGuard>
where
    F: Fn() + Send + Sync + 'static,
{
    let listener = TcpListener::bind(default_instance_addr())?;
    listener.set_nonblocking(true)?;

    let stop = Arc::new(AtomicBool::new(false));
    let stop_for_thread = Arc::clone(&stop);
    let on_wake: Arc<dyn Fn() + Send + Sync> = Arc::new(on_wake);
    let join = thread::Builder::new()
        .name("mhxy-shikong-control-single-instance".to_string())
        .spawn(move || run_listener(listener, stop_for_thread, on_wake))
        .map_err(|err| io::Error::other(err.to_string()))?;

    Ok(SingleInstanceGuard {
        stop,
        join: Mutex::new(Some(join)),
    })
}

fn run_listener(
    listener: TcpListener,
    stop: Arc<AtomicBool>,
    on_wake: Arc<dyn Fn() + Send + Sync>,
) {
    while !stop.load(Ordering::SeqCst) {
        match listener.accept() {
            Ok((stream, _)) => handle_connection(stream, on_wake.as_ref()),
            Err(err) if err.kind() == io::ErrorKind::WouldBlock => {
                thread::sleep(LISTENER_IDLE_SLEEP);
            }
            Err(_) => break,
        }
    }
}

fn handle_connection(mut stream: TcpStream, on_wake: &(dyn Fn() + Send + Sync)) {
    let _ = stream.set_read_timeout(Some(DEFAULT_NOTIFY_TIMEOUT));
    let _ = stream.set_write_timeout(Some(DEFAULT_NOTIFY_TIMEOUT));

    let mut message = Vec::with_capacity(INSTANCE_COMMAND.len());
    let mut byte = [0_u8; 1];
    while message.len() < 128 {
        match stream.read(&mut byte) {
            Ok(0) => break,
            Ok(_) => {
                message.push(byte[0]);
                if byte[0] == b'\n' {
                    break;
                }
            }
            Err(err)
                if err.kind() == io::ErrorKind::WouldBlock
                    || err.kind() == io::ErrorKind::TimedOut =>
            {
                break;
            }
            Err(_) => return,
        }
    }

    if message == INSTANCE_COMMAND {
        let _ = stream.write_all(INSTANCE_ACK);
        let _ = stream.flush();
        on_wake();
    }
}
