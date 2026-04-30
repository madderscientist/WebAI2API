import json
import subprocess
import requests


url = "http://localhost:8787/v1/responses"


def execute_js_code(obj):
    """本地执行 JS 的函数"""
    try:
        result = subprocess.run(["node", "-e", obj["javascript_code"]], capture_output=True, text=True, timeout=5)
        if result.returncode != 0:
            return f"Execution Error: {result.stderr}"
        return result.stdout.strip()
    except Exception as e:
        return f"System Error: {str(e)}"


def get_wearher(obj):
    location = obj["location"]
    return f"{location}的天气信息：雪天，42度"


tool_functions = {
    "exec_js": execute_js_code,
    "get_weather": get_wearher
}

input_items = [
    {
        "role": "user",
        "content": "任务1：请计算斐波那契数列的第 11 项是多少？\n任务2：南京的天气是什么？",
    }
]

tools = [
    {
        "type": "function",
        "name": "exec_js",
        "description": "Execute JavaScript code. Ensure the result is printed.",
        "parameters": {
            "type": "object",
            "properties": {
                "javascript_code": {
                    "type": "string",
                    "description": "The JS code to execute."
                }
            },
            "required": ["javascript_code"]
        }
    },
    {
        "type": "function",
        "name": "get_weather",
        "description": "Get the weather information for a specific location.",
        "parameters": {
            "type": "object",
            "properties": {
                "location": {
                    "type": "string",
                    "description": "The location to get the weather for."
                }
            },
            "required": ["location"]
        }
    }
]

print(f"{'='*20} 开始对话 {'='*20}")

previous_response_id = None

while True:
    payload = {
        "model": "deepseek",
        "input": input_items,
        "tool_choice": "auto",
    }
    if previous_response_id:
        payload["previous_response_id"] = previous_response_id
    else:
        payload["tools"] = tools

    response = requests.post(url, json=payload)
    if response.status_code != 200:
        print("❌ API 请求失败:", response.text)
        break

    body = response.json()


    previous_response_id = body["id"]
    output_items = body.get("output", [])

    assistant_text_parts = []
    tool_calls = []

    for item in output_items:
        item_type = item.get("type")
        if item_type in ("message", "reasoning"):
            content = item.get("content")
            if content:
                for part in content:
                    if part.get("type") == "output_text":
                        assistant_text_parts.append(part.get("text", ""))
                    else:
                        assistant_text_parts.append(part.get("redusal", ""))
        elif item_type == "function_call":
            tool_calls.append(item)

    assistant_text = "\n".join(assistant_text_parts).strip()

    if tool_calls:
        print(f"\n🤖 模型回复:\n{assistant_text if assistant_text else '[No content]'}")

        print("\n🤖 模型正在调用工具...")

        next_input_items = []
        for tool_call in tool_calls:
            name = tool_call["name"]
            arg = tool_call["arguments"]
            py_fn = tool_functions.get(name)
            if not py_fn:
                next_input_items.append({
                    "type": "function_call_output",
                    "call_id": tool_call["call_id"],
                    "output": f"Error: No implementation for tool {tool_call['name']}"
                })
            else:
                args = json.loads(arg)
                execution_result = py_fn(args)
                print(f"   ✅ 结果: {execution_result}")

                next_input_items.append(
                    {
                        "type": "function_call_output",
                        "call_id": tool_call["call_id"],
                        "output": str(execution_result),
                    }
                )

        input_items = next_input_items
        continue

    final_content = assistant_text
    print(f"\n🏁 最终回答:\n{final_content}")
    break
