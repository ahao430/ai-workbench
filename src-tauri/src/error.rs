use serde::Serialize;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum ErrorKind {
    /// 配置类错误（未接入服务、服务端特性不支持等），前端引导用户处理
    Config,
    /// 凭证失效，需要重新登录
    Unauthorized,
    /// 服务端返回的业务错误（success=false）
    Api,
    /// 网络层错误
    Network,
    /// 本地内部错误（文件/钥匙串等）
    Internal,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AppError {
    pub kind: ErrorKind,
    pub message: String,
}

impl AppError {
    pub fn config(message: impl Into<String>) -> Self {
        Self { kind: ErrorKind::Config, message: message.into() }
    }
    pub fn unauthorized(message: impl Into<String>) -> Self {
        Self { kind: ErrorKind::Unauthorized, message: message.into() }
    }
    pub fn api(message: impl Into<String>) -> Self {
        Self { kind: ErrorKind::Api, message: message.into() }
    }
    pub fn network(message: impl Into<String>) -> Self {
        Self { kind: ErrorKind::Network, message: message.into() }
    }
    pub fn internal(message: impl Into<String>) -> Self {
        Self { kind: ErrorKind::Internal, message: message.into() }
    }
}

impl std::fmt::Display for AppError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}", self.message)
    }
}

impl From<reqwest::Error> for AppError {
    fn from(e: reqwest::Error) -> Self {
        AppError::network(format!("网络请求失败：{}", error_chain(&e)))
    }
}

/// 取错误的完整 cause 链。reqwest 等包装错误的 Display 只显示最外层
/// （如 "error sending request for url (…)"），真实原因（连接被重置 / TLS 握手
/// 失败 / 超时）在 source 链里，不透出就没法排查。
pub fn error_chain(e: &dyn std::error::Error) -> String {
    let mut s = e.to_string();
    let mut cur = e.source();
    while let Some(cause) = cur {
        s.push_str(" ← ");
        s.push_str(&cause.to_string());
        cur = cause.source();
    }
    s
}
