import { NextResponse } from 'next/server';
import twilio from 'twilio';
import { Ratelimit } from '@upstash/ratelimit';
import { Redis } from '@upstash/redis';
import OpenAI from 'openai';

// Initialize OpenAI client
const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

// Initialize Redis for rate limiting
const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL || '',
  token: process.env.UPSTASH_REDIS_REST_TOKEN || '',
});

// Create rate limiter - updating to 30 requests per hour per phone number
const ratelimit = new Ratelimit({
  redis,
  limiter: Ratelimit.slidingWindow(300, '1 h'),
});

// Add these types at the top of the file
type TwilioError = {
  response?: {
    status: number;
    data: any;
  };
  message: string;
};

type OpenAIError = {
  message: string;
};

// Update the validateRequest function
const validateRequest = (request: Request, twilioSignature: string | null) => {
  // During development/testing, we can bypass signature validation
  if (process.env.NODE_ENV === 'development') {
    return true;
  }

  const twilioAuthToken = process.env.TWILIO_AUTH_TOKEN;
  const url = request.url;
  const params = Object.fromEntries(new URL(url).searchParams);

  return twilio.validateRequest(
    twilioAuthToken,
    twilioSignature || '',
    url,
    params
  );
};

// Add this helper function
function cleanMarkdownForWhatsApp(text: string): string {
  return text
    // Remove markdown headers (###, ##, #)
    .replace(/^#{1,6}\s/gm, '')
    // Remove duplicate asterisks while preserving WhatsApp formatting
    .replace(/\*{4}/g, '*')
    .replace(/\*{3}/g, '*')
    .replace(/\*{2}/g, '*')
    // Remove markdown list markers
    .replace(/^[-*+]\s/gm, '')
    .replace(/^\d+\.\s/gm, '')
    // Remove code blocks and backticks
    .replace(/```[\s\S]*?```/g, '')
    .replace(/`([^`]+)`/g, '$1')
    // Remove horizontal rules
    .replace(/^[-*_]{3,}\s*$/gm, '')
    // Clean up extra newlines
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

// Update the splitIntoWhatsAppMessages function
function splitIntoWhatsAppMessages(text: string, maxLength: number = 1500): string[] {
  console.log('Original message length:', text.length);
  console.log('First 50 chars:', text.substring(0, 50));
  console.log('Last 50 chars:', text.substring(text.length - 50));

  // Added better null/undefined handling
  if (!text) {
    console.log('⚠️ Warning: Empty text received');
    return ['No content available'];
  }

  // Clean up problematic characters that might cause issues
  text = text.replace(/\u0000/g, '')  // Remove null characters
           .replace(/\uFFFD/g, '')    // Remove replacement characters
           .replace(/\*/g, '')        // Remove asterisks
           .trim();

  if (text.length <= maxLength) {
    console.log('Message within length limit, sending as single message');
    return [text];
  }

  const messages: string[] = [];
  let currentMessage = '';
  const paragraphs = text.split('\n\n');

  console.log(`Split into ${paragraphs.length} paragraphs`);

  for (const paragraph of paragraphs) {
    // Improved paragraph handling
    const potentialMessage = currentMessage 
      ? currentMessage + '\n\n' + paragraph 
      : paragraph;

    if (potentialMessage.length > maxLength) {
      if (currentMessage) {
        messages.push(currentMessage);
        currentMessage = paragraph;
      } else {
        // If a single paragraph is too long, split by sentences
        const sentences = paragraph.match(/[^.!?]+[.!?]+/g) || [paragraph];
        for (const sentence of sentences) {
          if (currentMessage.length + sentence.length > maxLength) {
            if (currentMessage) messages.push(currentMessage);
            currentMessage = sentence;
          } else {
            currentMessage += sentence;
          }
        }
      }
    } else {
      currentMessage = potentialMessage;
    }
  }

  if (currentMessage) {
    messages.push(currentMessage);
  }

  console.log(`Split into ${messages.length} messages`);
  messages.forEach((msg, i) => {
    console.log(`Message ${i + 1} length: ${msg.length}`);
  });

  // Add message numbering if there are multiple messages, but without asterisks
  return messages.length > 1 
    ? messages.map((msg, i) => `Part ${i + 1}/${messages.length}\n\n${msg}`)
    : messages;
}

export async function POST(request: Request): Promise<Response> {
  try {
    console.log('🔵 Received webhook request');

    // Comment out timeout for development
    // const timeoutPromise = new Promise<Response>((_, reject) => {
    //   setTimeout(() => {
    //     reject(new Error('Processing timeout - request took too long'));
    //   }, 8000);
    // });

    // Modify processImagePromise to be a regular function call
    // const processImagePromise = async (): Promise<Response> => {
    const formData = await request.formData();
    const from = formData.get('From') as string;
    const body = formData.get('Body') as string;
    
    console.log('📱 Message from:', from);
    console.log('📝 Message body:', body);

    if (!formData.get('MediaUrl0')) {
      console.log('❌ No media received');
      return sendWhatsAppMessage(
        from,
        'Hello! Please send an image to digitize its content.'
      );
    }

    // Apply rate limiting
    const { success, reset } = await ratelimit.limit(from);
    if (!success) {
      const resetDate = new Date(reset);
      return sendWhatsAppMessage(
        from,
        `You've reached the limit of requests. Please try again after ${resetDate.toLocaleTimeString()}.`
      );
    }

    // Get the image content and handle the format
    const mediaUrl = formData.get('MediaUrl0') as string;
    console.log('🖼️ Media URL:', mediaUrl);

    try {
      // Create Twilio client for media handling
      const client = twilio(
        process.env.TWILIO_ACCOUNT_SID,
        process.env.TWILIO_AUTH_TOKEN
      );

      // Extract the Media SID from the URL
      const mediaSid = mediaUrl.split('/Media/')[1];
      console.log('🆔 Media SID:', mediaSid);

      // Get the media resource
      const media = await client.messages(formData.get('MessageSid') as string)
        .media(mediaSid)
        .fetch();
      
      // Get the actual content URL
      const contentUrl = media.uri.replace('.json', '');
      console.log('🔗 Content URL:', contentUrl);

      // Fetch the actual image
      const imageResponse = await fetch(`https://api.twilio.com${contentUrl}`, {
        headers: {
          Authorization: `Basic ${Buffer.from(
            `${process.env.TWILIO_ACCOUNT_SID}:${process.env.TWILIO_AUTH_TOKEN}`
          ).toString('base64')}`,
        },
      });

      const contentType = imageResponse.headers.get('content-type');
      console.log('📋 Content Type:', contentType);

      if (!contentType || !contentType.startsWith('image/')) {
        console.log('❌ Invalid content type:', contentType);
        return sendWhatsAppMessage(
          from,
          'Please send a valid image file (JPEG, PNG, GIF, or WEBP).'
        );
      }

      const imageBuffer = await imageResponse.arrayBuffer();
      console.log('📊 Image size:', {
        bytes: imageBuffer.byteLength,
        megabytes: (imageBuffer.byteLength / (1024 * 1024)).toFixed(2) + 'MB'
      });

      // Add size check
      if (imageBuffer.byteLength > 20 * 1024 * 1024) { // 20MB limit
        console.log('❌ Image too large');
        return sendWhatsAppMessage(
          from,
          'The image is too large. Please send an image smaller than 20MB.'
        );
      }

      const imageBase64 = Buffer.from(imageBuffer).toString('base64');

      // Add a timeout specifically for OpenAI request
      const openAiPromise = openai.chat.completions.create({
        model: "gpt-4o-mini",
        messages: [
          {
            role: "user",
            content: [
              { 
                type: "text", 
                text: "Please perform a thorough and complete extraction of ALL information from this image, including any small print, headers, footers, and side notes. Don't skip any text, no matter how minor it might seem.\n\nFormat the output in a clear, readable way:\n- Use line breaks between different sections\n- Keep paragraphs short for mobile readability\n- Maintain the logical structure of the content\n- Include all numbers, dates, and details\n- Preserve any lists or bullet points using simple dashes (-)\n\nEnsure NO information is omitted, even if it seems secondary or supplementary. Do not use any special formatting or symbols." 
              },
              {
                type: "image_url",
                image_url: {
                  url: `data:${contentType};base64,${imageBase64}`,
                },
              },
            ],
          },
        ],
        max_tokens: 10000,
      });

      console.log('🤖 Sending to OpenAI...');
      
      // Comment out the OpenAI timeout race
      // const completion = await Promise.race([
      //   openAiPromise,
      //   new Promise((_, reject) => {
      //     setTimeout(() => reject(new Error('OpenAI API timeout')), 7000);
      //   })
      // ]) as OpenAI.Chat.ChatCompletion;

      const completion = await openAiPromise as OpenAI.Chat.ChatCompletion;

      console.log('✅ OpenAI response received');
      const extractedText = completion?.choices[0]?.message?.content;
      
      if (!extractedText) {
        console.log('⚠️ No text extracted from image');
      } else {
        console.log('📝 Extracted text length:', extractedText.length);
      }

      return sendWhatsAppMessage(from, extractedText || 'No text could be extracted from the image.');

    } catch (error: unknown) {
      console.error('🔴 Error processing image:', error);
      
      const openAIError = error as OpenAIError;
      let errorMessage = 'Sorry, there was an error processing your image. Please try again with a different image.';
      if (openAIError?.message === 'OpenAI API timeout') {
        errorMessage = 'Processing took too long for our sandbox. Please try again with a clearer or smaller image.';
      }
      
      return sendWhatsAppMessage(from, errorMessage);
    }

    // };

    // return await Promise.race([processImagePromise(), timeoutPromise]);
    // Just return the response directly
    return NextResponse.json({ success: true });

  } catch (error: unknown) {
    console.error('🔴 Error processing request:', error);
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    );
  }
}

// Update the sendWhatsAppMessage function
async function sendWhatsAppMessage(to: string, message: string): Promise<Response> {
  const client = twilio(
    process.env.TWILIO_ACCOUNT_SID,
    process.env.TWILIO_AUTH_TOKEN
  );

  console.log('📤 Sending message to:', to);
  console.log('📝 Original message length:', message?.length || 0);
  
  // Ensure message is not undefined or null
  if (!message) {
    console.log('⚠️ Warning: Empty message received');
    message = 'No content available';
  }

  const messages = splitIntoWhatsAppMessages(message);
  console.log(`📬 Split into ${messages.length} messages`);

  try {
    for (const msgContent of messages) {
      console.log('📨 Sending message part:');
      console.log('- Length:', msgContent.length);
      console.log('- First 50 chars:', msgContent.substring(0, 50));
      console.log('- Last 50 chars:', msgContent.substring(msgContent.length - 50));

      const result = await client.messages.create({
        from: `whatsapp:${process.env.TWILIO_PHONE_NUMBER}`,
        to: to,
        body: msgContent,
      });

      console.log('Message sent with SID:', result.sid);
      
      if (messages.length > 1) {
        console.log('Waiting 1s before sending next part...');
        await new Promise(resolve => setTimeout(resolve, 1000));
      }
    }

    console.log('✅ All messages sent successfully');
    return NextResponse.json({ success: true });
  } catch (error: unknown) {
    console.error('🔴 Error sending message:', error);
    // Type guard for TwilioError
    const twilioError = error as TwilioError;
    if (twilioError.response) {
      console.error('Error details:', {
        status: twilioError.response.status,
        data: twilioError.response.data,
      });
    }
    return NextResponse.json({ 
      error: 'Failed to send message',
      details: twilioError.message 
    }, { status: 500 });
  }
}

export async function GET(request: Request): Promise<Response> {
  return new Response('Webhook endpoint is active');
}