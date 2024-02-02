import { NextRequest, NextResponse } from "next/server";
import { kv } from "@vercel/kv";
import {
  Factories,
  FarcasterNetwork,
  FrameActionBody,
  getSSLHubRpcClient,
  Message,
  MessageData,
  MessageType,
  toFarcasterTime,
  UserDataType,
} from "@farcaster/hub-nodejs";
import { readFileSync } from "fs";
import { join } from "path";
import { Hex, createClient, createPublicClient, encodeFunctionData, http } from "viem";
import { base } from "viem/chains";
import { mnemonicToAccount } from "viem/accounts";

import { getAccountNonce, createSmartAccountClient, estimateUserOperationGas } from "permissionless"
import { UserOperation, bundlerActions, getSenderAddress, getUserOperationHash, waitForUserOperationReceipt, GetUserOperationReceiptReturnType, signUserOperationHashWithECDSA } from "permissionless"
import { pimlicoBundlerActions, pimlicoPaymasterActions } from "permissionless/actions/pimlico"

const HUB_URL = process.env["HUB_URL"] || "nemes.farcaster.xyz:2283";
const hubClient = getSSLHubRpcClient(HUB_URL);

const publicClient = createPublicClient({
	transport: http("https://ethereum-sepolia.publicnode.com/"),
	chain: base,
});

// Encode 'click' call
const abi = JSON.parse(readFileSync(join(process.cwd(), "public/Yoink.json")).toString());

const chain = "base" // find the list of chain names on the Pimlico verifying paymaster reference page
const apiKey = process.env.PIMLICO_API_KEY; 
const entryPoint = process.env.ENTRY_POINT as `0x${string}`;

const bundlerClient = createClient({
	transport: http(`https://api.pimlico.io/v1/${chain}/rpc?apikey=${apiKey}`),
	chain: base,
})
	.extend(bundlerActions)
	.extend(pimlicoBundlerActions)
 
const paymasterClient = createClient({
	// ⚠️ using v2 of the API ⚠️
	transport: http(`https://api.pimlico.io/v2/${chain}/rpc?apikey=${apiKey}`),
	chain: base,
}).extend(pimlicoPaymasterActions);

const senderAddress = process.env.YOINK_CONTRACT as `0x${string}`;

const userOpSigner = mnemonicToAccount(process.env.USEROP_SIGNER_MNEMONIC as string);

const sendYoink = async (message: Message) => {
  console.log('message', message);
  console.log('frameActionBody', message.data?.frameActionBody);

  const messageSignature = Buffer.from(message.signature).toString('hex');
  console.log('signature', messageSignature);

  const messageData: MessageData = {
    type: message.data?.type as MessageType,
    fid: message.data?.fid as number,
    timestamp: message.data?.timestamp as number,
    network: message.data?.network as FarcasterNetwork,
    frameActionBody: message.data?.frameActionBody,
  };

  const messageEncoded = (MessageData.encode(messageData).finish());

  const args = [
    '0x' + Buffer.from(message.signer).toString('hex'),
    '0x' + Buffer.from(messageSignature).slice(0, 32).toString('hex'),
    '0x' + Buffer.from(messageSignature).slice(32, 64).toString('hex'),
    '0x' + Buffer.from(messageEncoded).toString('hex')
  ];

  console.log('args', args);

  const callData = encodeFunctionData({
    abi,
    functionName: 'click',
    args,
  });

  console.log('call data');
  console.log(callData);

  const gasPrice = await bundlerClient.getUserOperationGasPrice()

  const nonce = await getAccountNonce(publicClient, {
    sender: senderAddress,
    entryPoint,
  });

  // Create basic user operation
  const userOperation = {
    sender: senderAddress,
    nonce,
    initCode: '0x' as `0x${string}`,
    callData,
    maxFeePerGas: gasPrice.fast.maxFeePerGas,
    maxPriorityFeePerGas: gasPrice.fast.maxPriorityFeePerGas,
    // dummy signature, needs to be there so the SimpleAccount doesn't immediately revert because of invalid signature length
    signature:
      "0xa15569dd8f8324dbeabf8073fdec36d4b754f53ce5901e283c6de79af177dc94557fa3c9922cd7af2a96ca94402d35c39f266925ee6407aeb32b31d76978d4ba1c" as Hex,
  };

  const sponsorUserOperationResult = await paymasterClient.sponsorUserOperation({
    userOperation,
    entryPoint,
  });

  console.log("Received paymaster sponsor result:", sponsorUserOperationResult)

  const sponsoredUserOperation: UserOperation = {
    ...userOperation,
    preVerificationGas: sponsorUserOperationResult.preVerificationGas,
    verificationGasLimit: sponsorUserOperationResult.verificationGasLimit,
    callGasLimit: sponsorUserOperationResult.callGasLimit,
    paymasterAndData: sponsorUserOperationResult.paymasterAndData,
  };
  
  // Sign user operation
  const signature = await signUserOperationHashWithECDSA({
    account: userOpSigner,
    userOperation: sponsoredUserOperation,
    chainId: base.id,
    entryPoint: entryPoint,
  });
  sponsoredUserOperation.signature = signature;

  console.log("Generated signature:", signature);

  const userOperationHash = await bundlerClient.sendUserOperation({
    userOperation: sponsoredUserOperation,
    entryPoint,
  });
   
  console.log("Received User Operation hash:", userOperationHash);
   
  // let's also wait for the userOperation to be included, by continually querying for the receipts
  console.log("Querying for receipts...");
  const receipt = await bundlerClient.waitForUserOperationReceipt({
    hash: userOperationHash,
  });

  console.log(receipt);
  return receipt.receipt.transactionHash;
}


export const maxDuration = 300;


export async function POST(req: NextRequest) {
  const {
    trustedData: { messageBytes },
  } = await req.json();
  const frameMessage = Message.decode(Buffer.from(messageBytes, "hex"));

  const validateResult = await hubClient.validateMessage(frameMessage);
  if (validateResult.isOk() && validateResult.value.valid) {
    const validMessage = validateResult.value.message;
    const fid = validMessage?.data?.fid ?? 0;

    let urlBuffer = validMessage?.data?.frameActionBody?.url ?? [];
    const urlString = Buffer.from(urlBuffer).toString("utf-8");
    if (!urlString.startsWith(process.env["HOST"] ?? "")) {
      return new NextResponse("Bad Request", { status: 400 });
    }

    const userDataResult = await hubClient.getUserDataByFid({ fid });
    if (userDataResult.isOk()) {
      const userData = userDataResult.value;
      let name = `FID #${fid}`;
      for (const message of userData.messages) {
        if (message?.data?.userDataBody?.type === UserDataType.USERNAME) {
          name = message.data.userDataBody.value;
          break;
        }
      }
      const flag = (await kv.get("flag")) as string;
      const key = `yoinks:${name}`;
      let txHash = '';

      if (!flag || name.toString() !== flag.toString() || name.toString() === "fastfourier.eth") {
        await kv.set("flag", name)
        await kv.incr("yoinks");
        await kv.incr(key);

        txHash = await sendYoink(frameMessage);

        if (txHash !== '') {
          await kv.set(`tx:${name}`, txHash);
        }
      }

      const postUrl = `${process.env["HOST"]}/api/transaction`;
      const imageUrl = `${process.env["HOST"]}/api/images/yoink?date=${Date.now()}&name=${name}&txHash=${txHash}`;

      return new NextResponse(
        `<!DOCTYPE html>
      <html>
        <head>
          <title>Yoinked!</title>
          <meta property="og:title" content="Yoinked!" />
          <meta property="og:image" content="${imageUrl}" />
          <meta name="fc:frame" content="vNext" />
          <meta name="fc:frame:image" content="${imageUrl}" />
          <meta name="fc:frame:post_url" content="${postUrl}" />
          <meta name="fc:frame:button:1" content="Transaction" />
          <meta name="fc:frame:button:1:action" content="post_redirect" />
        </head>
        <body>Yoink</body>
      </html>`,
        {
          status: 200,
          headers: {
            "Content-Type": "text/html",
          },
        }
      );
    } else {
      return new NextResponse("Internal server error", { status: 500 });
    }
  } else {
    return new NextResponse("Unauthorized", { status: 401 });
  }
}

export const GET = POST;
