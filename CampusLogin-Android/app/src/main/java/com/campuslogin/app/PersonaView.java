package com.campuslogin.app;

import android.content.Context;
import android.graphics.Canvas;
import android.graphics.Color;
import android.graphics.Paint;
import android.graphics.RectF;
import android.util.AttributeSet;
import android.view.View;
import android.widget.Toast;

import java.util.Random;

/** A small original assistant character, drawn locally without brand names or assets. */
public class PersonaView extends View {
    private final Paint paint = new Paint(Paint.ANTI_ALIAS_FLAG);
    private final Random random = new Random();
    private int character = random.nextInt(3);
    private int expression = random.nextInt(5);
    private static final String[] MESSAGES = {
            "连接顺利，今天也保持在线。", "让我想想下一步。", "认证信息已准备好。",
            "网络似乎还在路上。", "连接完成，出发吧！"
    };

    public PersonaView(Context c, AttributeSet a) { super(c, a); init(); }
    private void init() {
        setOnClickListener(v -> {
            expression = (expression + 1) % MESSAGES.length;
            invalidate();
            Toast.makeText(getContext(), MESSAGES[expression], Toast.LENGTH_SHORT).show();
        });
    }

    @Override protected void onDraw(Canvas c) {
        super.onDraw(c);
        float s = Math.min(getWidth(), getHeight()) / 48f, cx = getWidth() / 2f, cy = getHeight() / 2f;
        int[] tones = { Color.rgb(36, 107, 87), Color.rgb(181, 121, 34), Color.rgb(81, 112, 151) };
        paint.setColor(tones[character]);
        c.drawRoundRect(new RectF(cx - 18*s, cy - 19*s, cx + 18*s, cy + 19*s), 14*s, 14*s, paint);
        paint.setColor(Color.rgb(255, 251, 241));
        c.drawCircle(cx, cy - 2*s, 12*s, paint);
        paint.setColor(tones[character]);
        paint.setStrokeWidth(2*s); paint.setStyle(Paint.Style.STROKE); paint.setStrokeCap(Paint.Cap.ROUND);
        float eyeY = cy - 5*s;
        if (expression == 1) { // thinking
            c.drawLine(cx - 7*s, eyeY, cx - 3*s, eyeY, paint); c.drawLine(cx + 3*s, eyeY, cx + 7*s, eyeY, paint);
            c.drawCircle(cx + 14*s, cy - 15*s, 2*s, paint);
        } else {
            c.drawCircle(cx - 5*s, eyeY, 1*s, paint); c.drawCircle(cx + 5*s, eyeY, 1*s, paint);
        }
        if (expression == 3) c.drawCircle(cx, cy + 5*s, 3*s, paint);
        else if (expression == 2) c.drawLine(cx - 4*s, cy + 6*s, cx + 4*s, cy + 6*s, paint);
        else c.drawArc(new RectF(cx - 6*s, cy, cx + 6*s, cy + 9*s), 10, 160, false, paint);
        paint.setStyle(Paint.Style.FILL);
        if (expression == 4) { paint.setColor(Color.rgb(241, 215, 155)); c.drawCircle(cx - 15*s, cy - 15*s, 2*s, paint); c.drawCircle(cx + 15*s, cy - 15*s, 2*s, paint); }
    }
}
