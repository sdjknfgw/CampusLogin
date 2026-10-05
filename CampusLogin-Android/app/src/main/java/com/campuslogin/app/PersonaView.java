package com.campuslogin.app;

import android.content.Context;
import android.util.AttributeSet;
import android.view.View;
import android.widget.Toast;

import java.util.Random;

/** A small original assistant character, drawn locally without brand names or assets. */
public class PersonaView extends View {
    private final Random random = new Random();
    private int expression = random.nextInt(10);
    private static final int[] IMAGES = {
            R.drawable.deepseek_mascot_happy, R.drawable.deepseek_mascot_thinking,
            R.drawable.deepseek_mascot_focused, R.drawable.deepseek_mascot_confused,
            R.drawable.deepseek_mascot_celebrating, R.drawable.deepseek_mascot_eating_rice,
            R.drawable.deepseek_mascot_surprised, R.drawable.deepseek_mascot_sleepy,
            R.drawable.deepseek_mascot_curious, R.drawable.deepseek_mascot_waving
    };
    private static final String[] MESSAGES = {
            "连接顺利，今天也保持在线。", "让我想想下一步。", "认证信息已准备好。",
            "网络似乎还在路上。", "连接完成，出发吧！", "我吃白饭怎么了",
            "咦？发现了新的网络线索。", "网络还没准备好，我先眯一会儿。",
            "前面是不是有新的连接？", "你好呀，今天也一起保持在线。"
    };

    public PersonaView(Context c, AttributeSet a) { super(c, a); init(); }
    private void init() {
        setOnClickListener(v -> {
            expression = (expression + 1) % MESSAGES.length;
            setBackgroundResource(IMAGES[expression]);
            invalidate();
            Toast.makeText(getContext(), MESSAGES[expression], Toast.LENGTH_SHORT).show();
        });
    }

    @Override protected void onAttachedToWindow() {
        super.onAttachedToWindow();
        setBackgroundResource(IMAGES[expression]);
    }
}
