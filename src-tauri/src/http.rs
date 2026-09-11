use std::sync::OnceLock;
use std::time::Duration;

use reqwest::Client;

/// 全局共享 reqwest 客户端（rustls + cookie 存储：兼容旧版 new-api 的 session 登录）。
/// reqwest 同时启用 rustls-tls 与 native-tls 时默认走 native，这里显式钉住 rustls，
/// 保持全局行为与历史一致。
pub fn http_client() -> &'static Client {
    static CLIENT: OnceLock<Client> = OnceLock::new();
    CLIENT.get_or_init(|| {
        Client::builder()
            .use_rustls_tls()
            .user_agent(concat!("ai-workbench/", env!("CARGO_PKG_VERSION")))
            .cookie_store(true)
            .timeout(Duration::from_secs(30))
            .build()
            .expect("failed to build reqwest client")
    })
}

/// 画图等长耗时请求用：180s 超时
pub fn long_client() -> &'static Client {
    static CLIENT: OnceLock<Client> = OnceLock::new();
    CLIENT.get_or_init(|| {
        Client::builder()
            .use_rustls_tls()
            .user_agent(concat!("ai-workbench/", env!("CARGO_PKG_VERSION")))
            .timeout(Duration::from_secs(180))
            .build()
            .expect("failed to build long-timeout reqwest client")
    })
}

/// 系统原生 TLS 栈（macOS Secure Transport / Windows Schannel）客户端。
/// 部分自建网关与 rustls 的握手会被掐断（tls handshake eof，1.2/1.3 皆然，
/// openssl/curl 均正常），这类兼容性问题的兜底走系统栈。
#[allow(dead_code)]
pub fn native_client() -> &'static Client {
    static CLIENT: OnceLock<Client> = OnceLock::new();
    CLIENT.get_or_init(|| {
        Client::builder()
            .use_native_tls()
            .user_agent(concat!("ai-workbench/", env!("CARGO_PKG_VERSION")))
            .cookie_store(true)
            .timeout(Duration::from_secs(30))
            .build()
            .expect("failed to build native-tls reqwest client")
    })
}
