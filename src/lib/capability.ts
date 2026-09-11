import type { ImageCallMode } from '../db/providers'

/** 专用文生图模型（走 /v1/images/generations）——数据参考 Cherry Studio 能力正则（设计参考，非代码拷贝） */
const DEDICATED_IMAGE =
  /dall[- ]?e|gpt-image|grok-2-image|imagen|flux|stable-?diffusion|sdxl|sd3|cogview|qwen-image|janus|midjourney|mj-|seedream|seededit|kolors-image|kandinsky|irag/i

/** 对话式生图模型（走 /v1/chat/completions 解析图片） */
const GENERATIVE_IMAGE = /gemini-[\w.]*-image|gemini-2\.0-flash-exp/i

/** 非聊天噪音模型（从聊天/画图候选中排除） */
const NOT_CHAT = /embed|whisper|tts|^speech|rerank|moderation|guard|clip|img2prompt/i

export interface AutoCapability {
  isImage: boolean
  callMode: ImageCallMode
  isChat: boolean
}

/** 按模型名自动识别（默认值；用户覆盖优先） */
export function autoCapability(modelId: string): AutoCapability {
  if (GENERATIVE_IMAGE.test(modelId)) return { isImage: true, callMode: 'chat', isChat: true }
  if (DEDICATED_IMAGE.test(modelId)) return { isImage: true, callMode: 'images', isChat: false }
  return { isImage: false, callMode: 'images', isChat: !NOT_CHAT.test(modelId) }
}

/** 合并用户覆盖：enabled=false 从画图列表剔除；callMode 指定调用方式 */
export async function resolveCapability(
  providerKey: string,
  modelId: string,
  getOverride: (p: string, m: string) => Promise<{ imageCallMode: ImageCallMode | null; imageEnabled: boolean | null } | null>,
): Promise<AutoCapability> {
  const auto = autoCapability(modelId)
  try {
    const o = await getOverride(providerKey, modelId)
    if (!o) return auto
    return {
      isImage: o.imageEnabled ?? auto.isImage,
      callMode: o.imageCallMode ?? auto.callMode,
      isChat: auto.isChat || (o.imageEnabled === true && o.imageCallMode === 'chat'),
    }
  } catch {
    return auto
  }
}
