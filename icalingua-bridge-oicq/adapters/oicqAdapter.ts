import MongoStorageProvider from '@icalingua/storage-providers/MongoStorageProvider'
import RedisStorageProvider from '@icalingua/storage-providers/RedisStorageProvider'
import SQLStorageProvider from '@icalingua/storage-providers/SQLStorageProvider'
import BilibiliMiniApp from '@icalingua/types/BilibiliMiniApp'
import IgnoreChatInfo from '@icalingua/types/IgnoreChatInfo'
import LoginForm from '@icalingua/types/LoginForm'
import Message from '@icalingua/types/Message'
import RoamingStamp from '@icalingua/types/RoamingStamp'
import Room from '@icalingua/types/Room'
import SearchableFriend from '@icalingua/types/SearchableFriend'
import SendMessageParams from '@icalingua/types/SendMessageParams'
import StorageProvider from '@icalingua/types/StorageProvider'
import StructMessageCard from '@icalingua/types/StructMessageCard'
import { faceIdToLottie } from '@icalingua/types/LottieFaceType'
import fs from 'fs'
import crypto from 'crypto'
import { base64decode } from 'nodejs-base64'
import {
    Client,
    createClient,
    DeviceEventData,
    FakeMessage,
    FriendAddEventData,
    FriendDecreaseEventData,
    FriendIncreaseEventData,
    FriendInfo,
    FriendPokeEventData,
    FriendRecallEventData,
    GroupAddEventData,
    GroupAdminEventData,
    GroupInfo,
    GroupInviteEventData,
    GroupMessageEventData,
    GroupMuteEventData,
    GroupPokeEventData,
    GroupRecallEventData,
    GroupSettingEventData,
    GroupSignEventData,
    GroupTitleEventData,
    GroupTransferEventData,
    LoginErrorEventData,
    MemberBaseInfo,
    MemberDecreaseEventData,
    MemberIncreaseEventData,
    MemberInfo,
    MessageElem,
    MessageEventData,
    OfflineEventData,
    PrivateMessageEventData,
    QrcodeEventData,
    Ret,
    Sendable,
    SliderEventData,
    SyncMessageEventData,
    SyncReadedEventData,
    SyncRemarkEventData,
} from 'oicq-icalingua-plus-plus'
import path from 'path'
import { Socket } from 'socket.io'
import { config, saveUserConfig, userConfig } from '../providers/configManager'
import { broadcast } from '../providers/socketIoProvider'
import clients from '../utils/clients'
import createRoom from '../utils/createRoom'
import formatDate from '../utils/formatDate'
import getImageUrlByMd5 from '../utils/getImageUrlByMd5'
import getSysInfo from '../utils/getSysInfo'
import createProcessMessage from '../utils/processMessage'
import sleep from '../utils/sleep'
import ChatGroup from '@icalingua/types/ChatGroup'
import SpecialFeature from '@icalingua/types/SpecialFeature'
import formatDuration from '../utils/formatDuration'
import { deleteUploadedFile, getUploadedFile } from '../utils/uploadFileManager'

let bot: Client
let storage: StorageProvider
let loginForm: LoginForm
let loginError: boolean = false
let _sendPrivateMsg: {
    (user_id: number, message: Sendable, auto_escape?: boolean): Promise<Ret<{ message_id: string }>>
}

let lastReceivedMessageInfo = {
    timestamp: 0,
    id: 0,
}

type CookiesDomain =
    | 'tenpay.com'
    | 'docs.qq.com'
    | 'office.qq.com'
    | 'connect.qq.com'
    | 'vip.qq.com'
    | 'mail.qq.com'
    | 'qzone.qq.com'
    | 'gamecenter.qq.com'
    | 'mma.qq.com'
    | 'game.qq.com'
    | 'qqweb.qq.com'
    | 'openmobile.qq.com'
    | 'qun.qq.com'
    | 'ti.qq.com'

//region event handlers
const eventHandlers = {
    async onQQMessage(data: MessageEventData | SyncMessageEventData) {
        if (data.time !== lastReceivedMessageInfo.timestamp) {
            lastReceivedMessageInfo.timestamp = data.time
            lastReceivedMessageInfo.id = 0
        }
        const now = new Date(data.time * 1000)
        const groupId = (data as GroupMessageEventData).group_id
        const senderId = data.sender.user_id
        let roomId = groupId ? -groupId : data.user_id
        if (await storage.isChatIgnored(roomId)) return
        const isSelfMsg = bot.uin === senderId
        let senderName: string
        if (groupId && (<GroupMessageEventData>data).anonymous)
            senderName = (<GroupMessageEventData>data).anonymous.name
        else if (groupId && isSelfMsg) senderName = 'You'
        else if (groupId) senderName = (data.sender as MemberBaseInfo).card || data.sender.nickname
        else senderName = (data.sender as FriendInfo).remark || data.sender.nickname
        let roomName = 'group_name' in data ? data.group_remark || data.group_name : senderName

        const message: Message = {
            senderId: senderId,
            username: senderName,
            content: '',
            timestamp: formatDate('hh:mm:ss', now),
            date: formatDate('yyyy/MM/dd', now),
            _id: data.message_id,
            role: (data.sender as MemberBaseInfo).role,
            title: groupId && (<GroupMessageEventData>data).anonymous ? '匿名' : (data.sender as MemberBaseInfo).title,
            files: [],
            anonymousId:
                groupId && (<GroupMessageEventData>data).anonymous ? (<GroupMessageEventData>data).anonymous.id : null,
            anonymousflag:
                groupId && (<GroupMessageEventData>data).anonymous
                    ? (<GroupMessageEventData>data).anonymous.flag
                    : null,
            bubble_id: data.bubble_id,
            subid: data.sender['subid'],
        }

        let room = await storage.getRoom(roomId)
        if (!room) {
            if (groupId) {
                const group = bot.gl.get(groupId)
                if (group) {
                    roomName = group.group_remark || group.group_name
                }
            } else if (data.post_type === 'sync') {
                const info = await adapter.getFriendInfo(data.user_id)
                roomName = info.remark || info.nickname
            }
            // create room
            room = createRoom(roomId, roomName)
            await storage.addRoom(room)
        } else {
            if (!room.roomName.startsWith(roomName) && data.post_type === 'message') {
                room.roomName = roomName
            }
        }

        //begin process msg
        const lastMessage = {
            content: '',
            timestamp: formatDate('hh:mm', now),
            username: senderName,
            userId: senderId,
        }
        ////process message////
        await processMessage(data.message, message, lastMessage, roomId)

        // 鬼知道服务器改了什么，收到的语言消息有时候没有 url，尝试重新获取
        if (message.content === '[无法处理的语音]undefined') {
            const regetMsg = await adapter.getMsg(data.message_id)
            if (!regetMsg.error && regetMsg.data) {
                message.content = ''
                await processMessage(regetMsg.data.message, message, lastMessage, roomId)
            }
        }

        // 自动回复消息作为小通知短暂显示
        if ('auto_reply' in data && data.auto_reply) {
            clients.message(message.content)
            return
        }

        const at = message.at
        if (at) room.at = at

        if (!room.priority) {
            room.priority = groupId ? 2 : 4
        }

        //可能要发通知，所以由客户端来决定
        let image
        if (message.file && message.file.type.startsWith('image/')) image = message.file.url
        broadcast('notify', {
            priority: room.priority,
            roomId,
            at,
            isSelfMsg,
            image,
            data: {
                title: room.roomName,
                body: (groupId ? senderName + ': ' : '') + lastMessage.content,
                hasReply: true,
                replyPlaceholder: 'Reply to ' + room.roomName,
            },
        })

        if (isSelfMsg) {
            room.unreadCount = 0
            room.at = false
        } else room.unreadCount++
        // 加上同一秒收到消息的id，防止消息乱序
        room.utime = data.time * 1000 + lastReceivedMessageInfo.id
        room.lastMessage = lastMessage
        message.time = data.time * 1000 + lastReceivedMessageInfo.id
        lastReceivedMessageInfo.id++
        if (await storage.isChatIgnored(senderId)) message.hide = true
        clients.addMessage(room.roomId, message)
        await storage.updateRoom(roomId, room)
        clients.updateRoom(room)
        storage.addMessage(roomId, message)
        if (config.custom && data.post_type === 'message') {
            try {
                require('../custom').onMessage(data, bot, { storage, ui: clients })
            } catch (e) {
                clients.messageError('自定义插件出错')
                console.error(e)
            }
        }
    },
    friendRecall(data: FriendRecallEventData) {
        const recallInfo = {
            time: Date.now(),
            operator_id: data.operator_id,
        }
        //clients.deleteMessage(data.message_id)
        clients.renewMessage(data.user_id, data.message_id, {
            deleted: true,
            reveal: false,
            recallInfo: JSON.stringify(recallInfo),
        })
        storage.updateMessage(data.user_id, data.message_id, {
            deleted: true,
            reveal: false,
            recallInfo: JSON.stringify(recallInfo),
        })
    },
    groupRecall(data: GroupRecallEventData) {
        const recallInfo = {
            time: Date.now(),
            operator_id: data.operator_id,
        }
        //clients.deleteMessage(data.message_id)
        clients.renewMessage(-data.group_id, data.message_id, {
            deleted: true,
            reveal: false,
            recallInfo: JSON.stringify(recallInfo),
        })
        storage.updateMessage(-data.group_id, data.message_id, {
            deleted: true,
            reveal: false,
            recallInfo: JSON.stringify(recallInfo),
        })
    },
    online() {
        clients.setOnline()
    },
    onOffline(data: OfflineEventData) {
        clients.setOffline(data.message)
    },
    async friendPoke(data: FriendPokeEventData) {
        const roomId = data.operator_id == bot.uin ? data.user_id : data.operator_id
        if (await storage.isChatIgnored(roomId)) return
        const room = await storage.getRoom(roomId)
        if (room) {
            room.utime = data.time * 1000
            let msg = ''
            if (data.operator_id != bot.uin) msg += room.roomName
            else msg += '你'
            msg += data.action
            if (data.operator_id == data.target_id) msg += '自己'
            else if (data.target_id != bot.uin) msg += room.roomName
            else msg += '你'
            if (data.suffix) msg += data.suffix
            room.lastMessage = {
                content: msg,
                username: null,
                timestamp: formatDate('hh:mm'),
                userId: data.operator_id,
            }
            const message: Message = {
                username: '',
                content: msg,
                senderId: data.operator_id,
                timestamp: formatDate('hh:mm:ss'),
                date: formatDate('yyyy/MM/dd'),
                _id: data.time,
                system: true,
                time: data.time * 1000,
                files: [],
            }
            clients.addMessage(roomId, message)
            clients.updateRoom(room)
            storage.updateRoom(room.roomId, room)
            storage.addMessage(roomId, message)
        }
    },
    async groupPoke(data: GroupPokeEventData) {
        if (await storage.isChatIgnored(-data.group_id)) return
        const room = await storage.getRoom(-data.group_id)
        if (room) {
            room.utime = data.time * 1000
            const operatorObj = (await bot.getGroupMemberInfo(data.group_id, data.operator_id, false)).data
            const operator = operatorObj
                ? operatorObj.card
                    ? operatorObj.card
                    : operatorObj.nickname
                : data.operator_id
            const userObj = (await bot.getGroupMemberInfo(data.group_id, data.user_id, false)).data
            const user = userObj ? (userObj.card ? userObj.card : userObj.nickname) : data.user_id
            let msg = ''
            if (data.operator_id !== bot.uin) msg += operator
            else msg += '你'
            msg += data.action
            if (data.user_id !== bot.uin) msg += user
            else if (data.operator_id === bot.uin) msg += '自己'
            else msg += '你'
            if (data.suffix) msg += data.suffix
            room.lastMessage = {
                content: msg,
                username: null,
                timestamp: formatDate('hh:mm'),
                userId: data.operator_id,
            }
            const message: Message = {
                username: '',
                content: msg,
                senderId: data.operator_id,
                timestamp: formatDate('hh:mm:ss'),
                date: formatDate('yyyy/MM/dd'),
                _id: `poke-${data.time * 1000}-${data.group_id}-${data.user_id}`,
                system: true,
                time: data.time * 1000,
                files: [],
            }
            clients.addMessage(room.roomId, message)
            clients.updateRoom(room)
            storage.updateRoom(room.roomId, room)
            storage.addMessage(room.roomId, message)
        }
    },
    async groupSign(data: GroupSignEventData) {
        console.log(data)
        if (await storage.isChatIgnored(-data.group_id)) return
        const room = await storage.getRoom(-data.group_id)
        if (room) {
            room.utime = data.time * 1000
            let msg = `${data.nickname} (${data.user_id}) ${data.sign_text}`
            room.lastMessage = {
                content: msg,
                username: null,
                timestamp: formatDate('hh:mm'),
                userId: data.user_id,
            }
            const message: Message = {
                username: '',
                content: msg,
                senderId: data.user_id,
                timestamp: formatDate('hh:mm:ss'),
                date: formatDate('yyyy/MM/dd'),
                _id: `sign-${data.time * 1000}-${data.group_id}-${data.user_id}`,
                system: true,
                time: data.time * 1000,
                files: [],
            }
            clients.addMessage(room.roomId, message)
            clients.updateRoom(room)
            storage.updateRoom(room.roomId, room)
            storage.addMessage(room.roomId, message)
        }
    },
    async groupMemberIncrease(data: MemberIncreaseEventData) {
        const now = new Date(data.time * 1000)
        const groupId = data.group_id
        const senderId = data.user_id
        const roomId = -groupId
        if (await storage.isChatIgnored(roomId)) return
        const message: Message = {
            _id: `${now.getTime()}-${groupId}-${senderId}`,
            content: `${data.nickname} (${data.user_id}) 加入了本群`,
            username: data.nickname,
            senderId,
            time: data.time * 1000,
            timestamp: formatDate('hh:mm:ss', now),
            date: formatDate('yyyy/MM/dd', now),
            system: true,
            files: [],
        }
        let room = await storage.getRoom(roomId)
        if (!room) {
            const group = bot.gl.get(groupId)
            let roomName = groupId.toString()
            if (group && (group.group_remark || group.group_name)) {
                roomName = group.group_remark || group.group_name
            }
            // create room
            room = createRoom(roomId, roomName)
            await storage.addRoom(room)
        }
        room.utime = data.time * 1000
        room.lastMessage = {
            content: message.content,
            username: '',
            timestamp: formatDate('hh:mm', now),
            userId: senderId,
        }
        clients.addMessage(roomId, message)
        clients.updateRoom(room)
        storage.updateRoom(roomId, room)
        storage.addMessage(roomId, message)
    },
    async groupMemberDecrease(data: MemberDecreaseEventData) {
        const now = new Date(data.time * 1000)
        const groupId = data.group_id
        const senderId = data.user_id
        const operator = (await bot.getGroupMemberInfo(groupId, data.operator_id)).data
        let roomId = -groupId
        if (await storage.isChatIgnored(roomId)) return
        const message: Message = {
            _id: `${now.getTime()}-${groupId}-${senderId}`,
            content: data.dismiss
                ? '群解散了'
                : (data.member ? (data.member.card ? data.member.card : data.member.nickname) : data.user_id) +
                  (data.operator_id === data.user_id
                      ? ` (${data.user_id}) 离开了本群`
                      : ` (${data.user_id}) 被 ${
                            operator ? (operator.card ? operator.card : operator.nickname) : data.operator_id
                        } (${data.operator_id}) 踢了`),
            username: data.member
                ? data.member.card
                    ? data.member.card
                    : data.member.nickname
                : data.user_id.toString(),
            senderId: data.operator_id,
            time: data.time * 1000,
            timestamp: formatDate('hh:mm:ss', now),
            date: formatDate('yyyy/MM/dd', now),
            system: true,
            files: [],
        }
        let room = await storage.getRoom(roomId)
        if (!room) {
            const group = bot.gl.get(groupId)
            let roomName = groupId.toString()
            if (group && (group.group_remark || group.group_name)) {
                roomName = group.group_remark || group.group_name
            }
            // create room
            room = createRoom(roomId, roomName)
            await storage.addRoom(room)
        }
        room.utime = data.time * 1000
        room.lastMessage = {
            content: message.content,
            username: '',
            timestamp: formatDate('hh:mm', now),
            userId: data.operator_id,
        }
        clients.addMessage(roomId, message)
        clients.updateRoom(room)
        storage.updateRoom(roomId, room)
        storage.addMessage(roomId, message)
    },
    async groupMute(data: GroupMuteEventData) {
        console.log(data)
        const roomId = -data.group_id
        if (await storage.isChatIgnored(roomId)) return
        const now = new Date(data.time * 1000)
        const operator = (await bot.getGroupMemberInfo(data.group_id, data.operator_id)).data
        let mutedUserName: string
        let muteAll = false
        if (data.user_id === 0) muteAll = true
        else if (data.user_id === 80000000) mutedUserName = data.nickname
        else {
            const mutedUser = (await bot.getGroupMemberInfo(data.group_id, data.user_id)).data
            mutedUserName = mutedUser ? mutedUser.card || mutedUser.nickname : data.user_id.toString()
        }
        let content = `${operator ? operator.card || operator.nickname : data.operator_id}(${data.operator_id}) `
        if (muteAll && data.duration > 0) content += '开启了全员禁言'
        else if (muteAll) content += '关闭了全员禁言'
        else if (data.duration === 0) content += `将 ${mutedUserName}(${data.user_id}) 解除禁言`
        else content += `禁言 ${mutedUserName}(${data.user_id}) ${formatDuration(data.duration)}`
        const message: Message = {
            _id: `mute-${now.getTime()}-${data.user_id}-${data.operator_id}`,
            content,
            username: operator ? operator.card || operator.nickname : data.operator_id.toString(),
            senderId: data.operator_id,
            time: data.time * 1000,
            timestamp: formatDate('hh:mm:ss', now),
            date: formatDate('yyyy/MM/dd', now),
            system: true,
            files: [],
        }
        let room = await storage.getRoom(roomId)
        if (!room) {
            const group = bot.gl.get(data.group_id)
            let roomName = data.group_id.toString()
            if (group && (group.group_remark || group.group_name)) {
                roomName = group.group_remark || group.group_name
            }
            // create room
            room = createRoom(roomId, roomName)
            await storage.addRoom(room)
        }
        room.utime = data.time * 1000
        room.lastMessage = {
            content: message.content,
            username: '',
            timestamp: formatDate('hh:mm', new Date(data.time)),
            userId: data.operator_id,
        }
        clients.addMessage(roomId, message)
        clients.updateRoom(room)
        storage.updateRoom(roomId, room)
        storage.addMessage(roomId, message)
    },
    async groupSetting(data: GroupSettingEventData) {
        console.log(data)
        const roomId = -data.group_id
        if (await storage.isChatIgnored(roomId)) return
        const enableMap = new Map<string, string>([
            ['enable_guest', '游客查看消息'],
            ['enable_anonymous', '群内匿名聊天'],
            ['enable_upload_album', '群员上传相册'],
            ['enable_upload_file', '群员上传文件'],
            ['enable_temp_chat', '群内临时会话'],
            ['enable_new_group', '群员发起新群'],
            ['enable_show_honor', '显示群员荣誉'],
            ['enable_show_level', '显示群员等级'],
            ['enable_show_title', '显示群员头衔'],
            ['enable_confess', '群内坦白说'],
        ])
        const now = new Date(data.time * 1000)
        const enableKeys = Object.keys(data).filter((key) => enableMap.has(key))
        let content = '管理员修改了群设置:'
        if (data.user_id) {
            try {
                const operator = (await bot.getGroupMemberInfo(data.group_id, data.user_id)).data
                content = `${operator ? operator.card || operator.nickname : data.user_id}(${
                    data.user_id
                }) 修改了群设置:`
            } catch (e) {}
        }
        let keys = ''
        for (const key of enableKeys) {
            content += ` ${data[key] ? '允许' : '禁止'}${enableMap.get(key)}`
            keys += key
        }
        if (data.avatar) {
            content += ' 群头像已变更'
        }
        const message: Message = {
            _id: `setting-${now.getTime()}-${data.group_id}-${keys}`,
            content,
            username: '群系统信息',
            senderId: 10000,
            time: data.time * 1000,
            timestamp: formatDate('hh:mm:ss', now),
            date: formatDate('yyyy/MM/dd', now),
            system: true,
            files: [],
        }
        let room = await storage.getRoom(roomId)
        const group = bot.gl.get(data.group_id)
        if (!room) {
            let roomName = data.group_id.toString()
            if (group && (group.group_remark || group.group_name)) {
                roomName = group.group_remark || group.group_name
            }
            // create room
            room = createRoom(roomId, roomName)
            await storage.addRoom(room)
        }
        if (data.group_name && data.group_name !== room.roomName) {
            room.roomName = (group && group.group_remark) || data.group_name
            message.content += ` 群名变更为 ${data.group_name}`
        } else if (data.group_name && data.group_name === room.roomName) return
        room.utime = data.time * 1000
        room.lastMessage = {
            content: message.content,
            username: '',
            timestamp: formatDate('hh:mm', new Date(data.time)),
        }
        clients.addMessage(roomId, message)
        clients.updateRoom(room)
        storage.updateRoom(roomId, room)
        storage.addMessage(roomId, message)
    },
    async groupTitle(data: GroupTitleEventData) {
        console.log(data)
        const roomId = -data.group_id
        if (await storage.isChatIgnored(roomId)) return
        const now = new Date(data.time * 1000)
        let content = `恭喜 ${data.nickname}(${data.user_id}) 获得群主授予的 ${data.title} 头衔`
        const message: Message = {
            _id: `title-${now.getTime()}-${data.group_id}-${data.user_id}`,
            content,
            username: '群系统信息',
            senderId: 10000,
            time: data.time * 1000,
            timestamp: formatDate('hh:mm:ss', now),
            date: formatDate('yyyy/MM/dd', now),
            system: true,
            files: [],
        }
        let room = await storage.getRoom(roomId)
        if (!room) {
            const group = bot.gl.get(data.group_id)
            let roomName = data.group_id.toString()
            if (group && (group.group_remark || group.group_name)) {
                roomName = group.group_remark || group.group_name
            }
            // create room
            room = createRoom(roomId, roomName)
            await storage.addRoom(room)
        }
        room.utime = data.time * 1000
        room.lastMessage = {
            content: message.content,
            username: '',
            timestamp: formatDate('hh:mm', now),
        }
        clients.addMessage(roomId, message)
        clients.updateRoom(room)
        storage.updateRoom(roomId, room)
        storage.addMessage(roomId, message)
    },
    async groupAdmin(data: GroupAdminEventData) {
        console.log(data)
        const roomId = -data.group_id
        if (await storage.isChatIgnored(roomId)) return
        const now = new Date(data.time * 1000)
        const newAdmin = (await bot.getGroupMemberInfo(data.group_id, data.user_id)).data
        let content = data.set
            ? `群主设置 ${newAdmin ? newAdmin.card || newAdmin.nickname : data.user_id} 为管理员`
            : `群主取消了 ${newAdmin ? newAdmin.card || newAdmin.nickname : data.user_id} 的管理员资格`
        const message: Message = {
            _id: `admin-${now.getTime()}-${data.group_id}-${data.user_id}`,
            content,
            username: '群系统信息',
            senderId: 10000,
            time: data.time * 1000,
            timestamp: formatDate('hh:mm:ss', now),
            date: formatDate('yyyy/MM/dd', now),
            system: true,
            files: [],
        }
        let room = await storage.getRoom(roomId)
        if (!room) {
            const group = bot.gl.get(data.group_id)
            let roomName = data.group_id.toString()
            if (group && (group.group_remark || group.group_name)) {
                roomName = group.group_remark || group.group_name
            }
            // create room
            room = createRoom(roomId, roomName)
            await storage.addRoom(room)
        }
        room.utime = data.time * 1000
        room.lastMessage = {
            content: message.content,
            username: '',
            timestamp: formatDate('hh:mm', new Date(data.time)),
        }
        clients.addMessage(roomId, message)
        clients.updateRoom(room)
        storage.updateRoom(roomId, room)
        storage.addMessage(roomId, message)
    },
    async groupTransfer(data: GroupTransferEventData) {
        console.log(data)
        const roomId = -data.group_id
        if (await storage.isChatIgnored(roomId)) return
        const now = new Date(data.time * 1000)
        const operator = (await bot.getGroupMemberInfo(data.group_id, data.operator_id)).data
        const transferredUser = (await bot.getGroupMemberInfo(data.group_id, data.user_id)).data
        let content = `${operator ? operator.card || operator.nickname : data.operator_id}(${
            data.operator_id
        }) 将群转让给了 ${transferredUser ? transferredUser.card || transferredUser.nickname : data.user_id}(${
            data.user_id
        })`
        const message: Message = {
            _id: `transfer-${now.getTime()}-${data.user_id}-${data.operator_id}`,
            content,
            username: operator ? operator.card || operator.nickname : data.operator_id.toString(),
            senderId: data.operator_id,
            time: data.time * 1000,
            timestamp: formatDate('hh:mm:ss', now),
            date: formatDate('yyyy/MM/dd', now),
            system: true,
            files: [],
        }
        let room = await storage.getRoom(roomId)
        if (!room) {
            const group = bot.gl.get(data.group_id)
            let roomName = data.group_id.toString()
            if (group && (group.group_remark || group.group_name)) {
                roomName = group.group_remark || group.group_name
            }
            // create room
            room = createRoom(roomId, roomName)
            await storage.addRoom(room)
        }
        room.utime = data.time * 1000
        room.lastMessage = {
            content: message.content,
            username: '',
            timestamp: formatDate('hh:mm', new Date(data.time)),
            userId: data.operator_id,
        }
        clients.addMessage(roomId, message)
        clients.updateRoom(room)
        storage.updateRoom(roomId, room)
        storage.addMessage(roomId, message)
    },
    async requestAdd(data: FriendAddEventData | GroupAddEventData | GroupInviteEventData) {
        //console.log(data)
        clients.sendAddRequest(data)
    },
    syncRead(data: SyncReadedEventData) {
        const roomId = data.sub_type === 'group' ? -data.group_id : data.user_id
        clients.syncRead(roomId)
        storage.updateRoom(roomId, { unreadCount: 0, at: false })
    },
    async syncRemark(data: SyncRemarkEventData) {
        if (data.sub_type === 'group') {
            const roomId = -data.group_id
            const room = await storage.getRoom(roomId)
            if (room) {
                room.roomName = data.remark || bot.gl.get(data.group_id).group_name
                clients.updateRoom(room)
                storage.updateRoom(roomId, room)
            }
        } else {
            const roomId = data.user_id
            const room = await storage.getRoom(roomId)
            if (room) {
                room.roomName = data.remark || bot.fl.get(data.user_id).nickname
                clients.updateRoom(room)
                storage.updateRoom(roomId, room)
            }
        }
    },
    //TODO 这里应该有好多重复代码的说，应该可以合并一下
    async friendIncrease(data: FriendIncreaseEventData) {
        const now = new Date(data.time * 1000)
        const senderId = data.user_id
        const roomId = senderId
        if (!roomId) return
        const roomName = data.nickname
        const message: Message = {
            _id: `${now.getTime()}-${senderId}-friendIncrease`,
            content: '你们成为了好友',
            username: data.nickname,
            senderId,
            time: data.time * 1000,
            timestamp: formatDate('hh:mm:ss', now),
            date: formatDate('yyyy/MM/dd', now),
            system: true,
            files: [],
        }
        let room = await storage.getRoom(roomId)
        if (!room) {
            // create room
            room = createRoom(roomId, roomName)
            await storage.addRoom(room)
        }
        room.utime = data.time * 1000
        room.lastMessage = {
            content: message.content,
            username: '',
            timestamp: formatDate('hh:mm', now),
            userId: senderId,
        }
        clients.addMessage(roomId, message)
        clients.updateRoom(room)
        storage.updateRoom(roomId, room)
        storage.addMessage(roomId, message)
    },
    async friendDecrease(data: FriendDecreaseEventData) {
        const now = new Date(data.time * 1000)
        const senderId = data.user_id
        const roomId = senderId
        if (!roomId) return
        const roomName = data.nickname
        const message: Message = {
            _id: `${now.getTime()}-${senderId}-friendIncrease`,
            content: '好友已删除',
            username: data.nickname,
            senderId,
            time: data.time * 1000,
            timestamp: formatDate('hh:mm:ss', now),
            date: formatDate('yyyy/MM/dd', now),
            system: true,
            files: [],
        }
        let room = await storage.getRoom(roomId)
        if (!room) {
            // create room
            room = createRoom(roomId, roomName)
            await storage.addRoom(room)
        }
        room.utime = data.time * 1000
        room.lastMessage = {
            content: message.content,
            username: '',
            timestamp: formatDate('hh:mm', now),
            userId: senderId,
        }
        clients.addMessage(roomId, message)
        clients.updateRoom(room)
        storage.updateRoom(roomId, room)
        storage.addMessage(roomId, message)
    },
}
const loginHandlers = {
    async onSucceed() {
        if (!adapter.loggedIn) {
            adapter.loggedIn = true
            await initStorage()
            attachEventHandler()
            setInterval(adapter.sendOnlineData, 1000 * 60)
            userConfig.account = loginForm
            saveUserConfig()
        }
        if (loginForm.onlineStatus) {
            await bot.setOnlineStatus(loginForm.onlineStatus)
        }
        console.log('上线成功')
        adapter.sendOnlineData()

        await sleep(3000)
        console.log('正在获取历史消息')
        {
            const rooms = await storage.getAllRooms()
            // 先私聊后群聊
            for (const i of rooms) {
                if (new Date().getTime() - i.utime > 1000 * 60 * 60 * 24 * 2) break
                if (i.roomId < 0) continue
                const roomId = i.roomId
                let buffer: Buffer
                let uid = roomId
                if (roomId < 0) {
                    buffer = Buffer.alloc(21)
                    uid = -uid
                } else buffer = Buffer.alloc(17)
                buffer.writeUInt32BE(uid, 0)
                adapter.fetchHistory(buffer.toString('base64'), roomId, 0)
                await sleep(500)
            }
            for (const i of rooms) {
                if (new Date().getTime() - i.utime > 1000 * 60 * 60 * 24 * 2) break
                if (i.roomId > 0) continue
                const roomId = i.roomId
                let buffer: Buffer
                let uid = roomId
                if (roomId < 0) {
                    buffer = Buffer.alloc(21)
                    uid = -uid
                } else buffer = Buffer.alloc(17)
                buffer.writeUInt32BE(uid, 0)
                adapter.fetchHistory(buffer.toString('base64'), roomId, 0)
                await sleep(500)
            }
        }
        clients.messageSuccess('历史消息获取完成')
    },
    verify(data: DeviceEventData) {
        console.log(data)
        broadcast('login-smsCodeVerify', data)
    },
    qrcode(data: QrcodeEventData) {
        const url = 'data:image/png;base64,' + data.image.toString('base64')
        broadcast('login-qrcodeLogin', url)
    },
    slider(data: SliderEventData) {
        broadcast('login-slider', data.url)
    },
    onErr(data: LoginErrorEventData) {
        broadcast('login-error', data.message + ` (${data.code})`)
        loginError = true
    },
}
//endregion
//region utility functions
const initStorage = async () => {
    try {
        switch (loginForm.storageType) {
            case 'mdb':
                storage = new MongoStorageProvider(loginForm.mdbConnStr, loginForm.username)
                break
            case 'redis':
                storage = new RedisStorageProvider(loginForm.rdsHost, `${loginForm.username}`)
                break
            case 'sqlite':
                storage = new SQLStorageProvider(`${loginForm.username}`, 'sqlite3', {
                    dataPath: 'data',
                })
                break
            case 'mysql':
                storage = new SQLStorageProvider(`${loginForm.username}`, 'mysql', {
                    host: loginForm.sqlHost,
                    user: loginForm.sqlUsername,
                    password: loginForm.sqlPassword,
                    database: loginForm.sqlDatabase,
                })
                break
            case 'pg':
                storage = new SQLStorageProvider(`${loginForm.username}`, 'pg', {
                    host: loginForm.sqlHost,
                    user: loginForm.sqlUsername,
                    password: loginForm.sqlPassword,
                    database: loginForm.sqlDatabase,
                })
                break
            default:
                break
        }
        await storage.connect()
        storage.getAllRooms().then((e) => {
            e.forEach((e) => {
                //更新群的名称
                if (e.roomId > -1) return
                const group = bot.gl.get(-e.roomId)
                if (group && (group.group_remark || group.group_name) !== e.roomName) {
                    storage.updateRoom(e.roomId, { roomName: group.group_remark || group.group_name })
                }
            })
        })
    } catch (err) {
        console.log(err)
        console.log('无法连接数据库')
        broadcast('fatal', '无法连接数据库')
        process.exit(2)
    }
}
const attachEventHandler = () => {
    bot.on('message', eventHandlers.onQQMessage)
    bot.on('sync.message', eventHandlers.onQQMessage)
    bot.on('notice.friend.recall', eventHandlers.friendRecall)
    bot.on('notice.group.recall', eventHandlers.groupRecall)
    bot.on('system.online', eventHandlers.online)
    bot.on('system.offline', eventHandlers.onOffline)
    bot.on('notice.friend.poke', eventHandlers.friendPoke)
    bot.on('notice.group.poke', eventHandlers.groupPoke)
    bot.on('notice.group.sign', eventHandlers.groupSign)
    bot.on('notice.group.increase', eventHandlers.groupMemberIncrease)
    bot.on('notice.group.decrease', eventHandlers.groupMemberDecrease)
    bot.on('notice.group.ban', eventHandlers.groupMute)
    bot.on('notice.group.setting', eventHandlers.groupSetting)
    bot.on('notice.group.title', eventHandlers.groupTitle)
    bot.on('notice.group.admin', eventHandlers.groupAdmin)
    bot.on('notice.group.transfer', eventHandlers.groupTransfer)
    bot.on('notice.friend.increase', eventHandlers.friendIncrease)
    bot.on('notice.friend.decrease', eventHandlers.friendDecrease)
    bot.on('request.friend.add', eventHandlers.requestAdd)
    bot.on('request.group.invite', eventHandlers.requestAdd)
    bot.on('request.group.add', eventHandlers.requestAdd)
    bot.on('sync.readed', eventHandlers.syncRead)
    bot.on('sync.remark', eventHandlers.syncRemark)
}
const attachLoginHandler = () => {
    bot.on('system.online', loginHandlers.onSucceed)
    bot.on('system.login.slider', loginHandlers.slider)
    bot.on('system.login.error', loginHandlers.onErr)
    bot.on('system.login.device', loginHandlers.verify)
    bot.on('system.login.qrcode', loginHandlers.qrcode)
}
//endregion

const adapter = {
    loggedIn: false,
    disabledFeatures: [] as SpecialFeature[],
    async getMsgNewURL(id: string, resolve): Promise<string> {
        const history = await adapter.getMsg(id)
        if (history.error) {
            console.log(history.error)
            if (history.error.message !== 'msg not exists') clients.messageError('错误：' + history.error.message)
            resolve('error')
            return
        }
        const data = history.data
        console.log(data)
        if (data) {
            const message: Message = {
                senderId: data.sender.user_id,
                username: data.sender.nickname,
                content: '',
                timestamp: formatDate('hh:mm:ss', new Date(data.time * 1000)),
                date: formatDate('yyyy/MM/dd', new Date(data.time * 1000)),
                _id: id,
                time: data.time * 1000,
                files: [],
                bubble_id: data.bubble_id,
            }
            await processMessage(data.message, message, {})
            if (message.file) {
                resolve(message.file.url || 'error')
                return
            }
        }
        resolve('error')
        return
    },
    getFriend(uin: number, resolve: (friend: FriendInfo) => any) {
        resolve(bot.fl.get(uin))
    },
    getGroup(gin: number, resolve: (group: GroupInfo) => any) {
        resolve(bot.gl.get(gin))
    },
    setGroupKick(gin: number, uin: number): any {
        bot.setGroupKick(gin, uin)
    },
    setGroupLeave(gin: number): any {
        bot.setGroupLeave(gin)
    },
    setGroupBan(gin: number, uin: number, duration?: number): any {
        bot.setGroupBan(gin, uin, duration)
    },
    setGroupAnonymousBan(gin: number, flag: string, duration?: number): any {
        bot.setGroupAnonymousBan(gin, flag, duration)
    },
    setGroupRemark(gin: number, remark: string): any {
        bot.setGroupRemark(gin, remark)
    },
    setFriendRemark(uin: number, remark: string): any {
        bot.setFriendRemark(uin, remark)
    },
    async makeForward(
        fakes: FakeMessage | Iterable<FakeMessage>,
        dm?: boolean,
        origin?: number,
        target?: number,
    ): Promise<any> {
        const xmlret = await bot.makeForwardMsg(fakes, dm, origin)
        if (xmlret.error) {
            console.log(xmlret.error)
            clients.messageError('错误：' + xmlret.error.message)
            return
        }
        if (!target) {
            clients.addMessageText(xmlret.data.data.data)
            clients.notify({
                title: '生成转发成功',
                message: '已在消息输入框中生成转发消息的 XML 对象，请使用鼠标中键单击发送按钮以发送此条转发消息。',
            })
        } else {
            adapter.sendMessage({
                content: xmlret.data.data.data,
                at: [],
                roomId: target,
                messageType: 'forward',
            })
        }
    },
    reportRead(messageId: string): any {
        bot.reportReaded(messageId)
    },
    async getGroupMembers(group: number, resolve) {
        const data = (await bot.getGroupMemberList(group, true)).data
        if (!data) {
            clients.messageError('获取群成员列表失败')
            resolve([])
            return
        }
        const values = data.values()
        let iter: IteratorResult<MemberInfo, MemberInfo> = values.next()
        const all: MemberInfo[] = []
        while (!iter.done) {
            all.push(iter.value)
            iter = values.next()
        }
        resolve(all)
    },
    setGroupNick(group: number, nick: string) {
        bot.setGroupCard(group, bot.uin, nick)
    },
    async getGroupMemberInfo(group: number, member: number, noCache: boolean, resolve) {
        resolve((await bot.getGroupMemberInfo(group, member, noCache)).data)
    },
    async _getGroupMemberInfo(group: number, member: number, noCache: boolean) {
        return (await bot.getGroupMemberInfo(group, member, noCache)).data
    },
    async getFriendsFallback(cb) {
        const friends = bot.fl.values()
        let iterF: IteratorResult<FriendInfo, FriendInfo> = friends.next()
        const friendsAll: SearchableFriend[] = []
        while (!iterF.done) {
            const f: SearchableFriend = {
                ...iterF.value,
                uin: iterF.value.user_id,
                nick: iterF.value.nickname,
                sc: iterF.value.nickname + iterF.value.remark + iterF.value.user_id,
            }
            friendsAll.push(f)
            iterF = friends.next()
        }
        cb(friendsAll)
    },
    async getFriendInfo(user_id: number): Promise<FriendInfo> {
        const friend = bot.fl.get(user_id)
        return friend || ((await bot.getStrangerInfo(user_id)).data as FriendInfo)
    },
    async getIgnoredChats(resolve) {
        resolve(await storage.getIgnoredChats())
    },
    removeIgnoredChat(roomId: number): any {
        return storage.removeIgnoredChat(roomId)
    },
    async getCookies(domain: CookiesDomain, resolve) {
        try {
            resolve((await bot.getCookies(domain)).data.cookies)
        } catch (e) {
            resolve('')
        }
    },
    //roomId 和 room 必有一个
    async sendMessage({
        content,
        roomId,
        file,
        replyMessage,
        room,
        b64img,
        imgpath,
        at,
        sticker,
        messageType,
    }: SendMessageParams) {
        if (!messageType) {
            messageType = 'text'
        }
        if (!room) room = await storage.getRoom(roomId)
        if (!roomId) roomId = room.roomId
        if (file && ((file.type && !file.type.includes('image') && !file.type.startsWith('audio')) || !file.type)) {
            const uploadedFile = getUploadedFile(file.path)
            //群文件
            if (roomId > 0) {
                bot.sendFile(roomId, uploadedFile.buffer, uploadedFile.fileName).then(async (data) => {
                    if (data.error) {
                        clients.notifyError({ title: '文件上传失败', message: data.error.message })
                        clients.closeLoading()
                        return
                    }
                    clients.messageSuccess('文件上传成功')
                    const message: Message = {
                        _id: data.data.message_id,
                        senderId: bot.uin,
                        username: 'You',
                        content,
                        timestamp: formatDate('hh:mm:ss'),
                        date: formatDate('yyyy/MM/dd'),
                        files: [],
                    }
                    message.file = {
                        type: file.type,
                        size: file.size,
                        url: '',
                        name: uploadedFile.fileName,
                    }
                    message.files.push(message.file)
                    const parsed = Buffer.from(data.data.message_id, 'base64')
                    const _time = parsed.readUInt32BE(12)
                    if (_time !== lastReceivedMessageInfo.timestamp) {
                        lastReceivedMessageInfo.timestamp = _time
                        lastReceivedMessageInfo.id = 0
                    }
                    message.time = _time * 1000 + lastReceivedMessageInfo.id
                    message.timestamp = formatDate('hh:mm:ss', new Date(_time * 1000))
                    lastReceivedMessageInfo.id++
                    clients.addMessage(roomId, message)
                    storage.addMessage(roomId, message)
                    clients.closeLoading()
                    deleteUploadedFile(file.path)
                })
            } else {
                const gfs = bot.acquireGfs(-roomId)
                gfs.upload(uploadedFile.buffer, undefined, uploadedFile.fileName)
                    .then((e) => {
                        deleteUploadedFile(file.path)
                        clients.closeLoading()
                    })
                    .catch((e) => {
                        console.error(e)
                        clients.messageError(e.message + '(' + e.code + ')')
                        clients.closeLoading()
                    })
            }
            clients.message('文件上传中')
            //clients.messageError('Not implicated')
            return
        }

        const chain: MessageElem[] = []

        if (messageType === 'anonymous') {
            if (roomId < 0)
                chain.push({
                    type: 'anonymous',
                    data: {
                        ignore: false, //匿名失败时不继续发送
                    },
                })
            messageType = 'text'
        }

        if (replyMessage) {
            chain.push({
                type: 'reply',
                data: {
                    id: replyMessage._id,
                    text: replyMessage.content,
                },
            })

            let replyUin = replyMessage.senderId
            if (!replyUin) {
                const parsed = Buffer.from(replyMessage._id, 'base64')
                replyUin = parsed.readUInt32BE(roomId < 0 ? 4 : 0)
            }

            if (roomId < 0 && replyUin !== 80000000)
                chain.push(
                    {
                        type: 'at',
                        data: {
                            qq: replyUin,
                        },
                    },
                    {
                        type: 'text',
                        data: {
                            text: ' ',
                        },
                    },
                )
        }
        if (content) {
            // 转换新 @
            const icalinguaAtRegex = /<IcalinguaAt qq=(\d+)>([^<]*)<\/IcalinguaAt>/
            while (icalinguaAtRegex.test(content)) {
                const icalinguaAt = icalinguaAtRegex.exec(content)
                try {
                    const atQQ = Number(icalinguaAt[1])
                    const name = decodeURIComponent(icalinguaAt[2])
                    at.push({
                        id: atQQ === 1 ? 'all' : atQQ,
                        text: name,
                    })
                    content = content.replace(icalinguaAt[0], name)
                } catch (e) {
                    console.error(e)
                    break
                }
            }
            //这里是处理@人和表情 markup 的逻辑
            const FACE_REGEX = /\[Face: (\d+)]/
            let splitContent = [content]
            // 把 @xxx 的部分单独分割开
            // '喵@小A @小B呜' -> ['喵', '@小A', ' ', '@小B', '呜']
            for (const { text } of at) {
                const newParts: string[] = []
                for (let part of splitContent) {
                    while (part.includes(text)) {
                        const index = part.indexOf(text)
                        const before = part.substr(0, index)
                        part = part.substr(index + text.length)
                        before && newParts.push(before)
                        newParts.push(text)
                    }
                    part && newParts.push(part)
                }
                splitContent = newParts
            }
            // 分离类似 [Face: 265] 的表情
            const newParts: string[] = []
            for (let part of splitContent) {
                if (at.find((e) => e.text === part)) {
                    // @的成分不做处理
                    newParts.push(part)
                    continue
                }
                while (FACE_REGEX.test(part)) {
                    const exec = FACE_REGEX.exec(part)
                    const index = exec.index
                    const before = part.substr(0, index)
                    const text = exec[0]
                    part = part.substr(index + text.length)
                    before && newParts.push(before)
                    newParts.push(text)
                }
                part && newParts.push(part)
            }
            splitContent = newParts
            // 最后根据每个 string 元素判断类型并且换成对应的 MessageElem
            for (const part of splitContent) {
                const atInfo = at.find((e) => e.text === part)
                const isFace = FACE_REGEX.test(part)
                let element: MessageElem
                if (atInfo)
                    element = {
                        type: 'at',
                        data: {
                            qq: atInfo.id,
                            text: atInfo.text,
                        },
                    }
                else if (isFace) {
                    var temp: string = FACE_REGEX.exec(part)[1]
                    element = {
                        type: 'face',
                        data: {
                            id: Number.parseInt(temp, 10),
                        },
                    }
                } else if (messageType === 'text') {
                    element = {
                        type: 'text',
                        data: {
                            text: part,
                        },
                    }
                } else if (messageType === 'json') {
                    chain.length = 0
                    chain.push({
                        type: 'json',
                        data: {
                            data: content,
                        },
                    })
                    break
                } else if (messageType === 'xml') {
                    chain.length = 0
                    chain.push({
                        type: 'xml',
                        data: {
                            data: content,
                        },
                    })
                    break
                } else if (messageType === 'forward') {
                    chain.length = 0
                    chain.push({
                        type: 'xml',
                        data: {
                            data: content,
                            type: 35,
                        },
                    })
                    break
                } else if (messageType === 'rps') {
                    chain.length = 0
                    chain.push({
                        type: 'rps',
                        data: {
                            id: parseInt(content),
                        },
                    })
                    break
                } else if (messageType === 'dice') {
                    chain.length = 0
                    chain.push({
                        type: 'dice',
                        data: {
                            id: parseInt(content),
                        },
                    })
                    break
                } else if (messageType === 'shake') {
                    chain.length = 0
                    chain.push({
                        type: 'shake',
                    })
                    break
                } else if (messageType === 'raw') {
                    // Only for debug
                    chain.length = 0
                    const rawMessage = JSON.parse(content)
                    chain.push(...rawMessage)
                    break
                }
                chain.push(element)
            }
        }
        if (b64img) {
            if (file && file.type.startsWith('audio')) {
                chain.push({
                    type: 'record',
                    data: {
                        file: Buffer.from(b64img.replace(/^data:.+;base64,/, ''), 'base64'),
                    },
                })
            } else {
                chain.push({
                    type: 'image',
                    data: {
                        file: 'base64://' + b64img.replace(/^data:.+;base64,/, ''),
                        type: sticker ? 'face' : 'image',
                        url: imgpath && imgpath.startsWith('send_') ? imgpath.replace('send_', '') : b64img,
                    },
                })
            }
        } else if (imgpath) {
            chain.push({
                type: 'image',
                data: {
                    file: imgpath,
                    type: sticker ? 'face' : 'image',
                    url: imgpath.replace(/\\/g, '/'),
                },
            })
        } else if (file) {
            chain.push({
                type: 'image',
                data: {
                    file: file.path,
                    type: sticker ? 'face' : 'image',
                    url: file.path,
                },
            })
        }
        if (messageType === 'text') {
            const idReg =
                content.match(/\[QLottie: (\d+)\,(\d+)\]/) || content.match(/\[QLottie: (\d+)\,(\d+)\,(\d+)\]/)
            if (idReg && idReg.length >= 3 && content === idReg[0]) {
                const qlottie = idReg[1]
                const faceId = idReg[2]
                const resultId = idReg[3]
                const lottieFace = faceIdToLottie.get(Number.parseInt(faceId, 10)) || { packId: '1', lottieId: qlottie }
                const packId = lottieFace.packId
                let extra = {
                    lottieType: 1,
                    packId: packId,
                    resultId: '',
                }
                if (resultId) {
                    extra.lottieType = 2
                    extra.resultId = resultId
                }
                lottieFace.lottieId = qlottie
                Object.assign(extra, lottieFace)
                chain.length = chain[0].type === 'anonymous' ? 1 : 0
                chain.push({
                    type: 'face',
                    data: {
                        id: Number.parseInt(faceId, 10),
                        qlottie: qlottie,
                        extra: JSON.stringify(extra),
                    },
                })
            }
        }
        //发送消息链
        let data: Ret<{ message_id: string }>
        if (roomId > 0) data = await bot.sendPrivateMsg(roomId, chain, true)
        else data = await bot.sendGroupMsg(-roomId, chain, true)

        clients.closeLoading()
        if (data.error) {
            if (messageType === 'json') {
                const md5 = (data) => crypto.createHash('md5').update(data).digest()
                const hash = md5(md5(content).toString() + String(Math.abs(roomId))).toString()
                const retData = await bot.sendJsonMsg(Math.abs(roomId), content, roomId < 0, hash)
                if (retData.error) {
                    clients.notifyError({
                        title: 'Failed to send',
                        message: retData.error.message,
                    })
                    clients.addMessageText(content)
                }
                return
            }
            clients.notifyError({
                title: 'Failed to send',
                message: data.error.message,
            })
            clients.addMessageText(content)
            return
        }
    },
    createBot(form: LoginForm) {
        if (!bot || form.username != bot.uin || loginError) {
            loginError = false
            const filepath = path.join(require.main ? require.main.path : process.cwd(), 'data', String(form.username))
            const devicepath = path.join(filepath, `device-${String(form.username)}.json`)
            if (!fs.existsSync(devicepath)) adapter.randomDevice(Number(form.username))
            bot = createClient(Number(form.username), {
                platform: Number(form.protocol),
                ignore_self: false,
                brief: true,
                sign_api_addr: form.signAPIAddress,
                sign_api_key: form.signAPIKey,
                force_algo_T544: form.forceAlgoT544,
                useNT: form.useNT,
            })
            _sendPrivateMsg = bot.sendPrivateMsg
            bot.sendPrivateMsg = async (user_id: number, message: MessageElem[] | string, auto_escape?: boolean) => {
                if (typeof message === 'string') message = [{ type: 'text', data: { text: message } }]
                let data = await _sendPrivateMsg.call(bot, user_id, message, auto_escape)
                if (user_id === bot.uin || user_id === 3636666661 || data.error) return data

                let custom_room = await storage.getRoom(user_id)
                if (!custom_room) {
                    // create room
                    const fl = bot.fl.get(user_id)
                    const roomName = fl ? fl.remark || fl.nickname : String(user_id)
                    custom_room = createRoom(user_id, roomName)
                    await storage.addRoom(custom_room)
                }
                const _message: Message = {
                    _id: '',
                    senderId: bot.uin,
                    username: 'You',
                    content: '',
                    timestamp: formatDate('hh:mm:ss'),
                    date: formatDate('yyyy/MM/dd'),
                    files: [],
                }
                const lastMessage = {
                    content: '',
                    timestamp: formatDate('hh:mm'),
                    username: 'You',
                    userId: bot.uin,
                }
                try {
                    await processMessage(message, _message, lastMessage, user_id)
                } catch (e) {
                    console.error(e)
                }
                custom_room.lastMessage = lastMessage
                _message._id = data.data.message_id
                const parsed = Buffer.from(data.data.message_id, 'base64')
                const _time = parsed.readUInt32BE(12)
                if (_time !== lastReceivedMessageInfo.timestamp) {
                    lastReceivedMessageInfo.timestamp = _time
                    lastReceivedMessageInfo.id = 0
                }
                custom_room.utime = _time * 1000 + lastReceivedMessageInfo.id
                _message.time = _time * 1000 + lastReceivedMessageInfo.id
                _message.timestamp = formatDate('hh:mm:ss', new Date(_time * 1000))
                lastReceivedMessageInfo.id++
                clients.updateRoom(custom_room)
                clients.addMessage(custom_room.roomId, _message)
                storage.addMessage(user_id, _message)
                storage.updateRoom(custom_room.roomId, {
                    utime: custom_room.utime,
                    lastMessage: custom_room.lastMessage,
                })
                return data
            }
            bot.setMaxListeners(233)
            attachLoginHandler()
        }
        loginForm = form
        bot.login(form.password)
    },
    async getGroups(resolve) {
        const groups = bot.gl.values()
        let iterG = groups.next()
        const groupsAll = [] as Array<GroupInfo & { sc: string }>
        while (!iterG.done) {
            const f = { ...iterG.value }
            f.sc = (f.group_name + f.group_remark + f.group_id).toUpperCase()
            groupsAll.push(f)
            iterG = groups.next()
        }
        resolve(groupsAll)
    },
    async fetchMessages(roomId: number, offset: number, client: Socket, callback: (arg0: Message[]) => void) {
        if (!offset) {
            storage.updateRoom(roomId, {
                unreadCount: 0,
                at: false,
            })
            if (roomId < 0) {
                const gid = -roomId
                const group = bot.gl.get(gid)
                const currentTimeStamp = Math.floor(Date.now() / 1000)
                if (group)
                    client.emit('setShutUp', group.shutup_time_me !== 0 && group.shutup_time_me > currentTimeStamp)
                else {
                    client.emit('setShutUp', true)
                    client.emit('message', '你已经不是群成员了')
                }
            } else {
                client.emit('setShutUp', false)
            }
        }
        const messages = (await storage.fetchMessages(roomId, offset, 20)) || []
        if (messages.length && !offset && messages.length && typeof messages[messages.length - 1]._id === 'string')
            adapter.reportRead(<string>messages[messages.length - 1]._id)
        callback(messages)
    },
    reLogin() {
        bot.login()
    },
    updateRoom(roomId: number, room: object) {
        if (!storage) return
        return storage.updateRoom(roomId, room)
    },
    updateChatGroup(name: string, chatGroup: ChatGroup) {
        return storage.updateChatGroup(name, chatGroup)
    },
    updateMessage(roomId: number, messageId: string, message: object) {
        return storage.updateMessage(roomId, messageId, message)
    },
    async sendGroupPoke(gin: number, uin: number) {
        const res = await bot.sendGroupPoke(gin, uin)
        if (res.error?.code === 1002) clients.messageError('对方已关闭头像双击功能')
    },
    async sendGroupSign(gin: number) {
        await bot.sendGroupSign(gin)
    },
    addRoom(room: Room) {
        return storage.addRoom(room)
    },
    addChatGroup(chatGroup: ChatGroup) {
        return storage.addChatGroup(chatGroup)
    },
    async getForwardMsg(resId: string, fileName: string, resolve) {
        const history = await bot.getForwardMsg(resId, fileName || 'MultiMsg')
        if (history.error) {
            console.log(history.error)
            const res: [Message] = [
                {
                    senderId: 0,
                    username: '错误',
                    content: history.error.message,
                    timestamp: formatDate('hh:mm:ss'),
                    date: formatDate('yyyy/MM/dd'),
                    _id: 0,
                    time: 0,
                    files: [],
                },
            ]
            resolve(res)
            return
        }
        const messages = []
        for (let i = 0; i < history.data.length; i++) {
            const data = history.data[i]
            data.time = Number(data.time)
            let message: Message
            try {
                message = {
                    senderId: data.user_id,
                    username: data.nickname,
                    content: '',
                    timestamp: formatDate('hh:mm:ss', new Date(data.time * 1000)),
                    date: formatDate('yyyy/MM/dd', new Date(data.time * 1000)),
                    _id: String(data.group_id || -1) + '|' + data.seq,
                    time: data.time * 1000,
                    files: [],
                    bubble_id: data.bubble_id,
                    head_img: data.head_img,
                }
                await processMessage(data.message, message, {})
            } catch (e) {
                message = {
                    senderId: 0,
                    username: '错误',
                    content: JSON.stringify(data),
                    code: JSON.stringify(e),
                    timestamp: formatDate('hh:mm:ss'),
                    date: formatDate('yyyy/MM/dd'),
                    _id: Date.now(),
                    time: Date.now(),
                    files: [],
                }
                console.error(e)
            }
            messages.push(message)
        }
        resolve(messages)
    },

    getBkn: () => bot.bkn,
    getUin: () => bot.uin,
    getGroupFileMeta: async (gin: number, fid: string, resolve) => {
        try {
            const res = await bot.acquireGfs(gin).download(fid)
            resolve(res)
        } catch (e) {
            console.error(e)
            resolve({
                name: e.message + '(' + e.code + ')',
                url: 'error',
            })
        }
    },
    getUnreadCount: async (priority: 1 | 2 | 3 | 4 | 5, resolve) => resolve(await storage.getUnreadCount(priority)),
    getFirstUnreadRoom: async (priority: 1 | 2 | 3 | 4 | 5, resolve) =>
        resolve(await storage.getFirstUnreadRoom(priority)),
    getRoom: async (roomId: number, resolve) => resolve(await storage.getRoom(roomId)),

    setOnlineStatus: (status: number) => bot.setOnlineStatus(status),
    logOut() {
        if (bot) bot.logout()
    },
    getMessageFromStorage: (roomId: number, msgId: string) => storage.getMessage(roomId, msgId),
    getMsg: (id: string) => bot.getMsg(id),

    async setRoomPriority(roomId: number, priority: 1 | 2 | 3 | 4 | 5) {
        await storage.updateRoom(roomId, { priority })
        clients.setAllRooms(await storage.getAllRooms())
    },
    async setRoomAutoDownload(roomId: number, autoDownload: boolean) {
        await storage.updateRoom(roomId, { autoDownload })
    },
    async setRoomAutoDownloadPath(roomId: number, downloadPath: string) {
        await storage.updateRoom(roomId, { downloadPath })
    },
    async pinRoom(roomId: number, pin: boolean) {
        await storage.updateRoom(roomId, { index: pin ? 1 : 0 })
        clients.setAllRooms(await storage.getAllRooms())
    },
    async ignoreChat(data: IgnoreChatInfo) {
        await storage.addIgnoredChat(data)
        await adapter.removeChat(data.id)
    },
    async removeChat(roomId: number) {
        await storage.removeRoom(roomId)
        clients.setAllRooms(await storage.getAllRooms())
    },
    async removeChatGroup(name: string) {
        await storage.removeChatGroup(name)
        clients.setAllChatGroups(await storage.getAllChatGroups())
    },
    async deleteMessage(roomId: number, messageId: string) {
        const res = await bot.deleteMsg(messageId)
        if (!res.error) {
            clients.deleteMessage(messageId)
            await storage.updateMessage(roomId, messageId, { deleted: true, reveal: false })
        } else {
            clients.notifyError({
                title: 'Failed to delete message',
                message: res.error.message,
            })
        }
    },
    async hideMessage(roomId: number, messageId: string) {
        await storage.updateMessage(roomId, messageId, { hide: true, reveal: false })
    },
    async renewMessage(roomId: number, messageId: string, message: Message) {
        let res = await adapter.getMsg(messageId)
        let messageIdBuf = Buffer.from(messageId, 'base64')
        if (res.error && roomId > 0 && messageIdBuf.length === 17) {
            const timestamp = messageIdBuf.readUInt32BE(12)
            const timeDiff = [-1, 1, -2, 2]
            for (let j of timeDiff) {
                messageIdBuf.writeUInt32BE(timestamp + j, 12)
                res = await adapter.getMsg(messageIdBuf.toString('base64'))
                if (!res.error) break
            }
        }
        if (!res.error) {
            const data = res.data
            const newMessage: Message = {
                senderId: message.senderId,
                username: message.username,
                content: '',
                timestamp: message.timestamp,
                date: message.date,
                _id: messageId,
                time: message.time,
                role: message.role,
                title: message.title,
                files: [],
                anonymousId: message.anonymousId,
                anonymousflag: message.anonymousflag,
                bubble_id: message.bubble_id,
            }
            try {
                await processMessage(data.message, newMessage, {}, roomId)
                await storage.replaceMessage(roomId, messageId, newMessage)
                clients.renewMessage(roomId, messageId, newMessage)
            } catch (e) {
                console.error(e)
            }
        } else {
            if (message.files.length) {
                let flag = false
                for (let i in message.files) {
                    if (message.files[i].type.startsWith('image') && message.files[i].url.includes('fileid=')) {
                        const fileId = message.files[i].url.match(/fileid=([^&]+)/)[1]
                        const res = await bot.getNTPicURLbyFileid(fileId)
                        if (!res.error) {
                            message.files[i].url = res.data
                            flag = true
                        }
                    }
                }
                if (flag) {
                    message.file = message.files[message.files.length - 1]
                    await storage.replaceMessage(roomId, messageId, message)
                    clients.renewMessage(roomId, messageId, message)
                    if (res.error.message !== 'msg not exists')
                        clients.messageError('错误：' + res.error.message + '，但已尝试刷新图片链接。')
                    else clients.messageError('错误：该消息不存在，但已尝试刷新图片链接。')
                    return
                }
            }
            if (res.error.message !== 'msg not exists') clients.messageError('错误：' + res.error.message)
            else clients.messageError('错误：该消息不存在。')
        }
    },
    async renewMessageURL(roomId: number, messageId: string | number, URL) {
        clients.renewMessageURL(messageId, URL)
    },
    async revealMessage(roomId: number, messageId: string | number) {
        clients.revealMessage(messageId)
        await storage.updateMessage(roomId, messageId, { hide: false, reveal: true })
    },
    async fetchHistory(messageId: string, roomId: number, currentLoadedMessagesCount: number) {
        console.log(`${roomId} 开始拉取消息`)
        clients.messageSuccess('开始拉取消息')
        const messages = []
        let lastMessage = {}
        let lastMessageTime = 0
        while (true) {
            const history = await bot.getChatHistory(messageId)
            if (history.error) {
                console.log(history.error)
                if (history.error.message !== 'msg not exists') clients.messageError('错误：' + history.error.message)
                break
            }
            const newMsgs: Message[] = []
            for (let i = 0; i < history.data.length; i++) {
                const data = history.data[i]
                const message: Message = {
                    senderId: data.sender.user_id,
                    username: (<GroupMessageEventData>data).group_id
                        ? (<GroupMessageEventData>data).anonymous
                            ? (<GroupMessageEventData>data).anonymous.name
                            : (<GroupMessageEventData>data).sender.card || data.sender.nickname
                        : (<PrivateMessageEventData>data).sender.remark || data.sender.nickname,
                    content: '',
                    timestamp: formatDate('hh:mm:ss', new Date(data.time * 1000)),
                    date: formatDate('yyyy/MM/dd', new Date(data.time * 1000)),
                    _id: data.message_id,
                    time: data.time * 1000,
                    role: (data.sender as MemberBaseInfo).role,
                    title:
                        (<GroupMessageEventData>data).group_id && (<GroupMessageEventData>data).anonymous
                            ? '匿名'
                            : (data.sender as MemberBaseInfo).title,
                    files: [],
                    anonymousId:
                        (<GroupMessageEventData>data).group_id && (<GroupMessageEventData>data).anonymous
                            ? (<GroupMessageEventData>data).anonymous.id
                            : null,
                    anonymousflag:
                        (<GroupMessageEventData>data).group_id && (<GroupMessageEventData>data).anonymous
                            ? (<GroupMessageEventData>data).anonymous.flag
                            : null,
                    bubble_id: (<GroupMessageEventData>data).bubble_id,
                }
                try {
                    const retData = await processMessage(data.message, message, {}, roomId)
                    if (await storage.isChatIgnored(message.senderId)) message.hide = true
                    messages.push(message)
                    newMsgs.push(message)
                    if (message.time > lastMessageTime) {
                        lastMessage = Object.assign(Object.assign({}, retData.message), retData.lastMessage, {
                            username: bot.uin == retData.message.senderId ? 'You' : retData.message.username,
                            timestamp: formatDate('hh:mm', new Date(message.time)),
                        })
                        lastMessageTime = retData.message.time
                    }
                } catch (e) {
                    console.error(e)
                }
            }
            if (history.data.length < 2 || newMsgs.length === 0) break
            messageId = newMsgs[0]._id as string
            //todo 所有消息都过一遍，数据库里面都有才能结束
            const firstOwnMsg =
                roomId < 0
                    ? newMsgs[0] //群的话只要第一条消息就行
                    : newMsgs.find((e) => e.senderId == bot.uin)
            if (!firstOwnMsg || (await storage.getMessage(roomId, firstOwnMsg._id as string))) break
        }
        // 私聊消息去重
        let messagesLength = messages.length
        if (roomId > 0) {
            for (let i = 0; i < messagesLength; i++) {
                //if (messages[i].senderId != bot.uin) continue
                try {
                    let messageIdBuf = Buffer.from(messages[i]._id as string, 'base64')
                    if (messageIdBuf.length != 17) continue
                    let timestamp = messageIdBuf.readUInt32BE(12)
                    const timeDiff = [0, -1, 1, -2, 2]
                    for (let j of timeDiff) {
                        messageIdBuf.writeUInt32BE(timestamp + j, 12)
                        if (await storage.getMessage(roomId, messageIdBuf.toString('base64'))) {
                            messages.splice(i, 1)
                            messagesLength--
                            i--
                            break
                        }
                    }
                } catch (e) {
                    console.error(e)
                }
            }
        }
        console.log(`${roomId} 已拉取 ${messages.length} 条消息`)
        let room = await storage.getRoom(roomId)
        clients.messageSuccess(`${room.roomName}(${Math.abs(roomId)}) 已拉取 ${messages.length} 条消息`)
        await storage.addMessages(roomId, messages)
        storage
            .fetchMessages(roomId, 0, currentLoadedMessagesCount + 20)
            .then((messages) => clients.setMessages(roomId, messages))

        // 更新最近消息
        if (!messages.length) return
        if (room.utime >= lastMessageTime) return
        room.lastMessage = lastMessage
        room.utime = lastMessageTime
        clients.updateRoom(room)
        await storage.updateRoom(roomId, {
            utime: room.utime,
            lastMessage: room.lastMessage,
        })
    },
    async sendOnlineData() {
        clients.sendOnlineData({
            online: bot.getStatus().data.online,
            nick: bot.nickname,
            uin: bot.uin,
            sysInfo: getSysInfo(),
            bkn: bot.bkn,
        })
        clients.setAllRooms(await storage.getAllRooms())
        clients.setAllChatGroups(await storage.getAllChatGroups())
    },
    async getRoamingStamp(no_cache: boolean | undefined, cb) {
        const roaming_stamp = (await bot.getRoamingStamp(no_cache)).data || []
        let stamps = []

        for (let index: number = roaming_stamp.length - 1; index >= 0; index--) {
            const stamp: RoamingStamp = {
                id: index,
                url: roaming_stamp[index],
            }

            stamps.push(stamp)
        }

        cb(stamps)
    },

    async getSystemMsg(cb) {
        const msgs = (await bot.getSystemMsg()).data
        let ret_msg = {}
        for (let index in msgs) {
            const flag = msgs[index].flag
            ret_msg[flag] = { ...msgs[index] }
            //ret_msg.push({flag: {...msgs[index]}})
        }

        cb(ret_msg)
    },

    async handleRequest(type: 'friend' | 'group', flag: string, accept: boolean = true) {
        switch (type) {
            case 'friend':
                return await bot.setFriendAddRequest(flag, accept)
            case 'group':
                return await bot.setGroupAddRequest(flag, accept)
        }
    },
    sliderLogin(ticket: string) {
        bot.sliderLogin(ticket)
    },

    acquireGfs(gin: number) {
        return bot.acquireGfs(gin)
    },
    submitSmsCode(smsCode: string) {
        if (smsCode === 'sendSmsCode') bot.sendSMSCode()
        else bot.submitSMSCode(smsCode)
    },
    randomDevice(username: number) {
        const filepath = path.join(require.main ? require.main.path : process.cwd(), 'data', String(username))
        const devicepath = path.join(filepath, `device-${String(username)}.json`)
        const randomString = (length: number, num: boolean = false) => {
            let result = ''
            const map = num ? '0123456789' : '0123456789abcdef'
            for (let i = length; i > 0; --i) result += map[Math.floor(Math.random() * map.length)]
            return result
        }
        const _genIMEI = () => {
            const imei = `86${randomString(12, true)}`
            function calcSP(imei: string) {
                let sum = 0
                for (let i = 0; i < imei.length; ++i) {
                    if (i % 2) {
                        let j = parseInt(imei[i]) * 2
                        sum += (j % 10) + Math.floor(j / 10)
                    } else {
                        sum += parseInt(imei[i])
                    }
                }
                return (100 - sum) % 10
            }
            return imei + calcSP(imei)
        }
        const imei = _genIMEI()
        const md5 = (data: string) => crypto.createHash('md5').update(data).digest()
        const device = `{
        "--begin--":    "该设备文件为尝试解决${username}的风控时随机生成。",
        "--version--":  2,
        "product":      "M2012K11AC",
        "device":       "alioth",
        "board":        "alioth",
        "brand":        "Redmi",
        "model":        "ILPP ${randomString(4).toUpperCase()}",
        "wifi_ssid":    "Redmi-${randomString(7).toUpperCase()}",
        "bootloader":   "U-boot",
        "android_ver":  "${randomString(4)}.${randomString(6, true)}.${randomString(4, true)}",
        "boot_id":      "${crypto.randomUUID()}",
        "proc_version": "Linux version 4.19.157-${randomString(13)} (android-build@xiaomi.com)",
        "mac_address":  "02:00:00:00:00:00",
        "ip_address":   "192.168.${randomString(2, true)}.${randomString(2, true)}",
        "imei":         "${imei}",
        "android_id":   "${md5(imei).toString('hex').slice(0, 16)}",
        "incremental":  "${randomString(10, true)}",
        "--end--":      "修改后可能需要重新验证设备。"
    }`
        if (fs.existsSync(filepath)) {
            fs.rmSync(filepath, { recursive: true, force: true })
        }
        fs.mkdirSync(filepath, { recursive: true, mode: 0o755 })
        fs.writeFileSync(devicepath, device, { mode: 0o600 })
    },
    async sendPacket(type: string, cmd: string, body: any, cb) {
        if (type === 'Uni') cb(await bot.sendUni(cmd, body))
        else cb(await bot.sendOidb(cmd, body))
    },
    async preloadImages(urls: string[]) {
        const ret = await bot.preloadImages(urls)
        if (ret.error) return false
        else return true
    },
}

const processMessage = createProcessMessage(adapter)

export default adapter
