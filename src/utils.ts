import process from "node:process";
import { pathToFileURL } from "node:url";

export function isDirectRun(meta_url = import.meta.url) {
    const entry = process.argv[1];
    if (!entry) return false;
    return meta_url === pathToFileURL(entry).href;
}

import fs from 'fs/promises';
/**
 * 从URL或本地路径获取文件内容，返回Buffer
 */
export async function getFileBufferFromUrl(
    url: string,    // 支持本地文件路径或 HTTP/HTTPS URL
    customHeaders?: Record<string, string>
): Promise<Buffer> {
    const isLocalFile = !url.startsWith('http://') && !url.startsWith('https://');
    if (isLocalFile) {
        try {
            return await fs.readFile(url);
        } catch (error: any) {
            throw new Error(`Failed to read local file: ${url} - ${error.message}`);
        }
    }

    const response = await fetch(url, {
        headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
            'Accept': 'image/webp,image/apng,image/*,*/*;q=0.8',
            'Connection': 'keep-alive',
            ...customHeaders
        }
    });

    // fetch 对 4xx/5xx 不会自动抛出异常，需手动判断
    if (!response.ok) throw new Error(`HTTP error! status: ${response.status}`);
    const arrayBuffer = await response.arrayBuffer();
    return Buffer.from(arrayBuffer);
}

export function base642Buffer(base64Input: string): Buffer {
  // 检查是否包含 Data URI 前缀（如 data:image/png;base64,）
  const base64Data = base64Input.includes(',') 
    ? base64Input.split(',')[1] 
    : base64Input;

  return Buffer.from(base64Data, 'base64');
}

/**
 * MIME类型检测
 * 优先级：扩展名 > 魔数 > 内容分析 > 默认值
 */
export function detectMimeType(buffer: Buffer, fileName = ''): string {
    // 空文件处理
    if (buffer.length === 0) return 'application/octet-stream';
    
    // ========== 1. 扩展名 ==========
    const ext = fileName.split('.').pop()?.toLowerCase();
    const extMap: Record<string, string> = {
        // 文本
        txt: 'text/plain', json: 'application/json', xml: 'application/xml',
        html: 'text/html', htm: 'text/html', css: 'text/css', js: 'application/javascript',
        csv: 'text/csv', md: 'text/markdown', log: 'text/plain', yaml: 'application/x-yaml',
        // 图片
        png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif',
        bmp: 'image/bmp', webp: 'image/webp', svg: 'image/svg+xml', ico: 'image/x-icon',
        // 文档
        pdf: 'application/pdf', doc: 'application/msword', docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        xls: 'application/vnd.ms-excel', xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        ppt: 'application/vnd.ms-powerpoint', pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
        // 压缩
        zip: 'application/zip', rar: 'application/x-rar-compressed', '7z': 'application/x-7z-compressed',
        gz: 'application/gzip', tar: 'application/x-tar',
        // 音视频
        mp3: 'audio/mpeg', wav: 'audio/wav', mp4: 'video/mp4', avi: 'video/x-msvideo',
        mov: 'video/quicktime', mkv: 'video/x-matroska',
        // 代码
        py: 'text/x-python', java: 'text/x-java', cpp: 'text/x-c++src', c: 'text/x-csrc',
        go: 'text/x-go', rs: 'text/x-rust', sh: 'application/x-shellscript',
    };
    if (ext && extMap[ext]) return extMap[ext];
    
    // ========== 2. 魔数 ==========
    const hex = buffer.toString('hex', 0, 8);
    const magicMap: Record<string, string> = {
        // 图片
        '89504e47': 'image/png',
        'ffd8ffe0': 'image/jpeg', 'ffd8ffe1': 'image/jpeg', 'ffd8ffdb': 'image/jpeg',
        '47494638': 'image/gif', '424d': 'image/bmp', '52494646': 'image/webp',
        // 文档/压缩
        '25504446': 'application/pdf',
        '504b0304': 'application/zip', '504b0506': 'application/zip', '504b0708': 'application/zip',
        'd0cf11e0': 'application/msword',
        '1f8b08': 'application/gzip', '52617221': 'application/x-rar-compressed',
        '377abcaf': 'application/x-7z-compressed',
        // 音视频
        '494433': 'audio/mpeg', 'fffb': 'audio/mpeg',
        '000001ba': 'video/mpeg', '000001b3': 'video/mpeg',
        '66747970': 'video/mp4', '4d546864': 'video/quicktime',
        // 其他
        '7f454c46': 'application/x-elf', 'cafebabe': 'application/java-archive',
        '4d5a': 'application/x-msdos-program',
    };
    for (const [magic, mime] of Object.entries(magicMap)) {
        if (hex.startsWith(magic)) return mime;
    }
    
    // ========== 3. 内容分析 ==========
    if (isTextContent(buffer)) {
        try {
            const text = buffer.toString('utf-8').trim();
            if ((text.startsWith('{') && text.endsWith('}')) || 
                (text.startsWith('[') && text.endsWith(']'))) return 'application/json';
            if (text.startsWith('<?xml') || text.startsWith('<')) return 'application/xml';
            if (text.includes('<!DOCTYPE html>') || text.includes('<html')) return 'text/html';
            if (text.includes('{') && text.includes('}') && /color|font|margin/.test(text)) return 'text/css';
            if (/function|=>|console\.log|var |let |const /.test(text)) return 'application/javascript';
        } catch {}
        return 'text/plain';
    }
    
    // ========== 4. 默认 ==========
    return 'application/octet-stream';
}

/**
 * 检测是否为纯文本内容
 */
function isTextContent(buffer: Buffer): boolean {
    const checkSize = Math.min(buffer.length, 512);
    let controlCount = 0;
    
    for (let i = 0; i < checkSize; i++) {
        const byte = buffer[i];
        if (byte === 0x00) return false; // 空字节 = 二进制
        if (byte < 32 && byte !== 9 && byte !== 10 && byte !== 13) {
            controlCount++;
        }
    }
    
    return (controlCount / checkSize) < 0.05; // 5%阈值
}