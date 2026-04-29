import requests
import json
import subprocess

# --- 配置与工具函数 ---
url = "http://localhost:8787/v1/chat/completions"

def execute_js_code(code):
    """本地执行 JS 的函数"""
    try:
        result = subprocess.run(["node", "-e", code], capture_output=True, text=True, timeout=5)
        if result.returncode != 0:
            return f"Execution Error: {result.stderr}"
        return result.stdout.strip()
    except Exception as e:
        return f"System Error: {str(e)}"

messages = [
    # {"role": "system", "content": "You are a helpful assistant. Use exec_js for calculations."},
    {"role": "user", "content": "请计算斐波那契数列的第 11 项是多少？"}
]

tools = [
    {
        "type": "function",
        "function": {
            "name": "exec_js",
            "description": "Execute JavaScript code. Ensure the result is printed.",
            "parameters": {
                "type": "object",
                "properties": {
                    "javascript_code": {"type": "string", "description": "The JS code to execute."}
                },
                "required": ["javascript_code"]
            }
        }
    }
]

print(f"{'='*20} 开始对话 {'='*20}")

while True:
    # 1. 发送请求
    payload = {
        "model": "deepseek",
        "messages": messages,
        "tools": tools,
        "tool_choice": "auto"
    }
    
    response = requests.post(url, json=payload)
    if response.status_code != 200:
        print("❌ API 请求失败:", response.text)
        break
        
    body = response.json()
    message = body["choices"][0]["message"]
    print(f"\n🤖 模型回复:\n{message.get('content', '[No content]')}")
    
    # 2. 把模型的回复（无论是文字还是工具调用）存入历史
    messages.append(message)
    
    # 3. 判断是否有工具调用
    tool_calls = message.get("tool_calls", [])
    
    if tool_calls:
        print("\n🤖 模型正在调用工具...")
        
        # 遍历所有工具调用（防止模型一次调多个）
        for tool_call in tool_calls:
            if tool_call['function']['name'] == 'exec_js':
                # A. 提取代码
                args = json.loads(tool_call['function']['arguments'])
                code_to_run = args['javascript_code']

                # B. 执行代码
                execution_result = execute_js_code(code_to_run)
                print(f"   ✅ 结果: {execution_result}")
                
                # C. 构造工具响应消息
                tool_message = {
                    "role": "tool",
                    "tool_call_id": tool_call['id'], # 本库中ID为原始调用代码
                    "content": str(execution_result)
                }
                
                # D. 将结果加入历史，准备下一轮循环
                messages.append(tool_message)

        # 从message中删除tool_calls，因为content中有包括工具调用的所有的信息
        del message['tool_calls']
        
        # 继续下一次 while 循环（把结果发给模型）
        continue 
        
    else:
        # 4. 如果没有工具调用，说明任务完成，输出最终回答
        final_content = message.get("content")
        print(f"\n🏁 最终回答:\n{final_content}")
        break