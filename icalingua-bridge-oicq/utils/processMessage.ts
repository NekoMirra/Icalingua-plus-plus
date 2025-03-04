import BilibiliMiniApp from '@icalingua/types/BilibiliMiniApp'
import Message from '@icalingua/types/Message'
import StructMessageCard from '@icalingua/types/StructMessageCard'
import { base64decode } from 'nodejs-base64'
import { AtElem, FriendInfo, GroupMessageEventData, MemberBaseInfo, MessageElem } from 'oicq-icalingua-plus-plus'
import path from 'path'
import type oicqAdapter from '../adapters/oicqAdapter'
import getImageUrlByMd5 from './getImageUrlByMd5'
import mime from './mime'
import silkDecode from './silkDecode'

const createProcessMessage = (adapter: typeof oicqAdapter) => {
    const processMessage = async (oicqMessage: MessageElem[], message: Message, lastMessage, roomId = null) => {
        if (!Array.isArray(oicqMessage)) oicqMessage = [oicqMessage]

        lastMessage.content = lastMessage.content ?? '' // 初始化最近信息内容

        let lastType
        let lastReply = false
        let replyAnonymous = false
        let markdown = ''
        for (let i = 0; i < oicqMessage.length; i++) {
            const m = oicqMessage[i] || { type: 'unknown', data: {} }
            let appurl
            let url
            switch (m.type) {
                case 'at':
                    if (lastType === 'reply' && !replyAnonymous) {
                        lastReply = true
                        break
                    }
                // noinspection FallThroughInSwitchStatementJS 确信
                case 'text':
                    // PCQQ 发送的消息的换行符是 \r，统一转成 \n
                    let text = m.data.text.split('\r\n').join('\n').split('\r').join('\n')
                    // 去除 \x00 字符，防止 postgreSQL 存储失败
                    text = text.split('\x00').join('')
                    if (lastReply) {
                        lastReply = false
                        text = text.replace(/^ /, '')
                    }
                    lastMessage.content += text
                    if ((m as AtElem).data.qq === 'all' && message.senderId !== 2854196310) {
                        message.at = 'all'
                    } else if ((m as AtElem).data.qq == adapter.getUin()) {
                        message.at = true
                    }
                    if (m.type === 'at') {
                        const atQQ = m.data.qq === 'all' ? 1 : m.data.qq
                        text = `<IcalinguaAt qq=${atQQ}>${encodeURIComponent(text).replace(/\./g, '%2E')}</IcalinguaAt>`
                    }
                    message.content += text
                    break
                case 'flash':
                    message.flash = true
                // noinspection FallThroughInSwitchStatementJS 确信
                case 'image':
                    lastMessage.content += '[Image]'
                    url = m.data.url || ''
                    if (typeof m.data.file !== 'string' && !url) {
                        const md5 = require('crypto').createHash('md5').update(m.data.file).digest('hex')
                        url = getImageUrlByMd5(md5)
                    }
                    if (typeof m.data.file === 'string' && !url) url = m.data.file
                    if (url && typeof url === 'string' && url.startsWith('base64://')) {
                        const base64 = url.slice(9)
                        const md5 = require('crypto')
                            .createHash('md5')
                            .update(Buffer.from(base64, 'base64'))
                            .digest('hex')
                        url = getImageUrlByMd5(md5)
                    }
                    if (typeof m.data.file === 'string' && url.includes('c2cpicdw.qpic.cn')) {
                        const md5 = m.data.file.substr(0, 32)
                        ;/^([a-f\d]{32}|[A-F\d]{32})$/.test(md5) && (url = getImageUrlByMd5(md5))
                    }
                    message.file = {
                        type: 'image/jpeg',
                        url,
                    }
                    message.files.push(message.file)
                    break
                case 'bface':
                    lastMessage.content += '[Sticker]' + m.data.text
                    url = `https://gxh.vip.qq.com/club/item/parcel/item/${m.data.file.substr(
                        0,
                        2,
                    )}/${m.data.file.substr(0, 32)}/raw300.gif`
                    message.file = {
                        type: 'image/webp',
                        url,
                    }
                    message.files.push(message.file)
                    break
                case 'file':
                    lastMessage.content += '[File]' + m.data.name
                    message.content += m.data.name
                    message.file = {
                        type: mime(path.extname(m.data.name)),
                        size: m.data.size,
                        url: m.data.url,
                        name: m.data.name,
                        fid: m.data.fid,
                    }
                    message.files.push(message.file)
                    break
                case 'share':
                    lastMessage.content += '[Link]' + m.data.title
                    message.content += m.data.url
                    break
                case 'reply':
                    let user_id: number, time: number
                    const parsed = Buffer.from(m.data.id, 'base64')
                    if (m.data.id.length > 24) {
                        // Group
                        user_id = parsed.readUInt32BE(4)
                        time = parsed.readUInt32BE(16)
                    } else {
                        // C2C
                        user_id = parsed.readUInt32BE(0)
                        time = parsed.readUInt32BE(12)
                    }
                    if (user_id === 80000000) replyAnonymous = true
                    let replyMessage: Message
                    if (roomId) {
                        replyMessage = await adapter.getMessageFromStorage(roomId, m.data.id)
                    }
                    if (!replyMessage) {
                        //get the message
                        const getRet = await adapter.getMsg(m.data.id)
                        if (getRet.data) {
                            //获取到库里面还没有的历史消息
                            //暂时先不加回库里了
                            const data = getRet.data
                            const senderName =
                                'group_id' in data
                                    ? (data as GroupMessageEventData).anonymous
                                        ? (data as GroupMessageEventData).anonymous.name
                                        : adapter.getUin() === data.sender.user_id
                                        ? 'You'
                                        : (data.sender as MemberBaseInfo).card || data.sender.nickname
                                    : (data.sender as FriendInfo).remark || data.sender.nickname
                            replyMessage = {
                                _id: '',
                                date: '',
                                senderId: 0,
                                timestamp: '',
                                username: senderName,
                                content: '',
                                files: [],
                            }
                            await processMessage(data.message, replyMessage, {})
                        }
                    }
                    if (replyMessage) {
                        message.replyMessage = {
                            _id: m.data.id,
                            username: replyMessage.username,
                            content: replyMessage.content,
                            files: [],
                        }
                        if (replyMessage.file) {
                            //兼容旧版本
                            message.replyMessage.file = replyMessage.file
                        }
                        if (replyMessage.files) {
                            message.replyMessage.files = replyMessage.files
                        }
                        if (replyMessage.senderId === adapter.getUin()) message.at = true
                    } else {
                        try {
                            message.replyMessage = {
                                _id: m.data.id,
                                username: user_id === adapter.getUin() ? 'You' : String(user_id),
                                content: `无法找到原消息(${m.data.id})(${time})`,
                                files: [],
                            }
                            if (m.data.text) {
                                message.replyMessage.content = m.data.text
                            }
                        } catch (err) {
                            console.error(err)
                        }
                    }
                    break
                case 'json':
                    const json: string = m.data.data
                    message.code = json
                    if (!json) break
                    const jsonObj = JSON.parse(json)
                    if (jsonObj.app === 'com.tencent.mannounce') {
                        try {
                            const title = base64decode(jsonObj.meta.mannounce.title)
                            const content = base64decode(jsonObj.meta.mannounce.text)
                            lastMessage.content = `[${title}]`
                            message.content = title + '\n\n' + content
                            if (jsonObj.meta.mannounce.pic) {
                                for (const pic of jsonObj.meta.mannounce.pic) {
                                    if (!pic.url) continue
                                    message.file = {
                                        type: 'image/jpeg',
                                        url: `https://gdynamic.qpic.cn/gdynamic/${pic.url}/0`,
                                    }
                                    message.files.push(message.file)
                                }
                            }
                            break
                        } catch (err) {}
                    } else if (jsonObj.app === 'com.tencent.multimsg') {
                        try {
                            const resId = jsonObj.meta?.detail?.resid
                            const fileName = jsonObj.meta?.detail?.uniseq
                            if (resId) {
                                lastMessage.content += '[Forward multiple messages]'
                                message.content = `[Forward: ${resId}]`
                                break
                            } else if (fileName) {
                                lastMessage.content += '[Forward multiple messages]'
                                message.content = `[NestedForward: ${fileName}]`
                                break
                            }
                        } catch (err) {}
                    }
                    const biliRegex = /(https?:\\?\/\\?\/b23\.tv\\?\/\w*)\??/
                    const zhihuRegex = /(https?:\\?\/\\?\/\w*\.?zhihu\.com\\?\/[^?"=]*)\??/
                    const biliRegex2 = /(https?:\\?\/\\?\/\w*\.?bilibili\.com\\?\/[^?"=]*)\??/
                    //const jsonLinkRegex = /{.*"app":"com.tencent.structmsg".*"jumpUrl":"(https?:\\?\/\\?\/[^",]*)".*}/
                    const jsonAppLinkRegex = /"contentJumpUrl": ?"(https?:\\?\/\\?\/[^",]*)"/
                    if (biliRegex.test(json)) appurl = json.match(biliRegex)[1].replace(/\\\//g, '/')
                    else if (biliRegex2.test(json)) appurl = json.match(biliRegex2)[1].replace(/\\\//g, '/')
                    else if (zhihuRegex.test(json)) appurl = json.match(zhihuRegex)[1].replace(/\\\//g, '/')
                    //else if (jsonLinkRegex.test(json)) appurl = json.match(jsonLinkRegex)[1].replace(/\\\//g, '/')
                    else if (jsonAppLinkRegex.test(json)) appurl = json.match(jsonAppLinkRegex)[1].replace(/\\\//g, '/')
                    else {
                        //作为一般通过小程序解析内部 URL，像腾讯文档就可以
                        try {
                            const meta = (<BilibiliMiniApp>jsonObj).meta.detail_1
                            appurl = meta.qqdocurl
                        } catch (e) {}
                    }
                    if (appurl) {
                        try {
                            const meta =
                                (<BilibiliMiniApp>jsonObj).meta.detail_1 || (<StructMessageCard>jsonObj).meta.news
                            lastMessage.content = meta.title + ' ' + meta.desc + ' '
                            message.content = meta.title + '\n\n' + meta.desc + '\n\n'

                            let previewUrl = meta.preview
                            if (!previewUrl.toLowerCase().startsWith('http')) {
                                previewUrl = 'https://' + previewUrl
                            }
                            message.file = {
                                type: 'image/jpeg',
                                url: previewUrl,
                            }
                            message.files.push(message.file)
                        } catch (e) {}

                        lastMessage.content += appurl
                        message.content += appurl
                    } else if (
                        jsonObj.app === 'com.tencent.groupphoto' ||
                        jsonObj.app === 'com.tencent.qzone.albumShare'
                    ) {
                        try {
                            const pics = jsonObj.meta.albumData.pics
                            pics.forEach((pic: any) => {
                                let pUrl = pic.url
                                if (!pUrl.toLowerCase().startsWith('http')) {
                                    pUrl = 'https://' + pUrl
                                }
                                message.file = {
                                    type: 'image/jpeg',
                                    url: pUrl,
                                }
                                message.files.push(message.file)
                            })
                        } catch (e) {}

                        lastMessage.content += '[群相册]' + jsonObj.prompt
                        message.content += '[群相册]' + jsonObj.prompt
                    } else {
                        lastMessage.content = '[JSON]' + (jsonObj.prompt || '')
                        message.content = '[JSON]' + (jsonObj.prompt || '') + '\n\n'
                        try {
                            const urlRegex = /"jumpUrl": *"([^"]+)"/
                            const previewRegex = /"preview": *"([^"]+)"/
                            const jumpUrl = json.match(urlRegex)
                            if (jumpUrl && jumpUrl[1])
                                message.content += jumpUrl[1].replace(/\\\//g, '/').replace(/&amp;/g, '&')
                            const preview = json.match(previewRegex)
                            if (preview && preview[1]) {
                                message.file = {
                                    type: 'image/jpeg',
                                    url: preview[1],
                                }
                                message.files.push(message.file)
                            }
                        } catch (e) {}
                    }
                    break
                case 'xml':
                    message.code = m.data.data
                    const urlRegex = /url="([^"]+)"/
                    const md5ImageRegex = /image [^<>]*md5="([A-F\d]{32})"/
                    if (urlRegex.test(m.data.data)) appurl = m.data.data.match(urlRegex)[1].replace(/\\\//g, '/')
                    if (m.data.data.includes('action="viewMultiMsg"')) {
                        lastMessage.content += '[Forward multiple messages]'
                        message.content += '[Forward multiple messages]'
                        const resIdRegex = /m_resid="([\w+=/]+)"/
                        const fileNameRegex = /m_fileName="([\w+-=/]+)"/
                        if (resIdRegex.test(m.data.data)) {
                            const resId = m.data.data.match(resIdRegex)[1]
                            console.log(resId)
                            message.content = `[Forward: ${resId}]`
                        } else if (fileNameRegex.test(m.data.data)) {
                            const fileName = m.data.data.match(fileNameRegex)[1]
                            console.log(fileName)
                            message.content = `[NestedForward: ${fileName}]`
                        }
                    } else if (appurl) {
                        appurl = appurl.replace(/&amp;/g, '&')
                        lastMessage.content = appurl
                        message.content = appurl
                    } else if (md5ImageRegex.test(m.data.data)) {
                        const imgMd5 = (appurl = m.data.data.match(md5ImageRegex)[1])
                        lastMessage.content += '[Image]'
                        url = getImageUrlByMd5(imgMd5)
                        message.file = {
                            type: 'image/jpeg',
                            url,
                        }
                        message.files.push(message.file)
                    } else {
                        const brief_reg = m.data.data.match(/brief="([^"]+)"/)
                        lastMessage.content += '[XML]'
                        message.content += '[XML]'
                        if (brief_reg && brief_reg[1]) {
                            lastMessage.content += brief_reg[1]
                            message.content += brief_reg[1]
                        }
                    }
                    break
                case 'face':
                    message.content += `[Face: ${m.data.id}]`
                    lastMessage.content += `[${m.data.text ? m.data.text : '表情'}]`
                    if (m.data.qlottie) {
                        let qlottie = m.data.qlottie.replace(/\D/g, '')
                        if (!qlottie) qlottie = '0'
                        message.content = `[QLottie: ${qlottie},${m.data.id}]`
                        if (m.data.extra) {
                            try {
                                const extra = JSON.parse(m.data.extra)
                                if (extra.resultId && Number(extra.resultId)) {
                                    message.content = `[QLottie: ${qlottie},${m.data.id},${Number(extra.resultId)}]`
                                }
                            } catch (e) {}
                        }
                    }
                    break
                case 'video':
                    message.content = ''
                    lastMessage.content = `[Video]`
                    message.file = {
                        type: 'video/mp4',
                        url: m.data.url || m.data.file,
                        fid: m.data.file,
                    }
                    message.files.push(message.file)
                    break
                case 'record':
                    try {
                        const fileName = await silkDecode(m.data.url)
                        message.file = {
                            type: 'audio/ogg',
                            url: fileName,
                            name: fileName,
                        }
                        if (typeof m.data.file === 'string') {
                            message.file.fid = m.data.file
                        }
                        message.files.push(message.file)
                    } catch (e) {
                        message.file = null
                        message.content = '[无法处理的语音]' + m.data.url
                        message.code = JSON.stringify({ error: e })
                    }
                    lastMessage.content = '[Audio]'
                    break
                case 'mirai':
                    try {
                        message.mirai = JSON.parse(m.data.data)
                        if (!message.mirai.eqq) {
                            message.mirai = null
                            break
                        } else if (message.mirai.eqq.type === 'tg' && message.mirai.eqq.version === 2) {
                            if (message.mirai.eqq.noSplitSender) break
                            const index = message.content.indexOf(': \n')
                            let sender = ''
                            if (index > -1) {
                                sender = message.content.substring(0, index)
                                message.content = message.content.substring(index + 3)
                            } else {
                                //是图片之类没有真实文本内容的
                                //去除尾部：
                                sender = message.content.substring(0, message.content.length - 2)
                                message.content = ''
                            }
                            message.username = lastMessage.username = sender
                            lastMessage.content = lastMessage.content.substring(sender.length + 3)
                        } else if (message.mirai.eqq.type === 'tg') {
                            const index = message.content.indexOf('：\n')
                            let sender = ''
                            if (index > -1) {
                                sender = message.content.substr(0, index)
                                message.content = message.content.substr(index + 2)
                            } else {
                                //是图片之类没有真实文本内容的
                                //去除尾部：
                                sender = message.content.substr(0, message.content.length - 1)
                                message.content = ''
                            }
                            message.username = lastMessage.username = sender
                            lastMessage.content = lastMessage.content.substr(sender.length + 1)
                        }
                    } catch (e) {}
                    break
                case 'rps':
                    const rps = ['石头', '剪刀', '布']
                    lastMessage.content += '[猜拳]'
                    message.content += '[猜拳]' + rps[m.data.id - 1]
                    break
                case 'dice':
                    lastMessage.content += '[随机骰子]'
                    message.content += '[随机骰子]点数' + m.data.id
                    break
                case 'shake':
                    lastMessage.content += '[窗口抖动]'
                    message.content += '[窗口抖动]'
                    break
                case 'poke':
                    const pokemap = {
                        0: '回戳',
                        1: '戳一戳',
                        2: '比心',
                        3: '点赞',
                        4: '心碎',
                        5: '666',
                        6: '放大招',
                        2000: '敲门',
                        2001: '抓一下',
                        2002: '碎屏',
                        2003: '勾引',
                        2004: '手雷',
                        2005: '结印',
                        2006: '召唤术',
                        2007: '玫瑰花',
                        2009: '让你皮',
                        2011: '宝贝球',
                    }
                    lastMessage.content += '[' + (pokemap[m.data.type] || pokemap[m.data.id]) + ']'
                    message.content += '[' + (pokemap[m.data.type] || pokemap[m.data.id]) + ']'
                    break
                case 'sface':
                    lastMessage.content += '[sFace: ' + m.data.text + '(' + m.data.id + ')]'
                    message.content += '[sFace: ' + m.data.text + '(' + m.data.id + ')]'
                    break
                case 'markdown':
                    markdown += m.data.markdown
                    break
                default:
                    console.log('[无法解析的消息]', m)
                    break
            }
            lastType = m.type
        }
        if (markdown) {
            try {
                const imageRegex = /!\[.*?\]\((.*?)\)/g
                const imageUrl = markdown.match(imageRegex)
                if (imageUrl) {
                    for (const url of imageUrl) {
                        const imgUrl = url.match(/\((.*?)\)/)[1]
                        message.file = {
                            type: 'image/jpeg',
                            url: imgUrl,
                        }
                        message.files.push(message.file)
                    }
                }
            } catch (e) {}
            message.content += markdown
        }
        return { message, lastMessage }
    }
    return processMessage
}

export default createProcessMessage
